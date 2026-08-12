import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import {
  ensureDirs,
  purgeStaleSessions,
  readSession,
  readSessions,
  removeSession,
  writeSession,
} from '../src/spool/persist';
import { reduceAll } from '../src/store/reduce';
import type { Session, SpoolEvent } from '../src/events/types';

// `node:fs/promises` est mocké pour un seul test (N1) : il permet de mettre en
// pause la suppression d'un fichier de session précis — le point où la purge
// est « occupée » sur une autre session — le temps qu'un autre appel (simulant
// une autre fenêtre) réécrive une session ailleurs. Un point d'entrelacement
// réel, piloté plutôt que chronométré. Délègue à l'implémentation réelle sauf
// quand ce test arme `unlinkOverride`.
const { unlinkOverride } = vi.hoisted(() => ({
  unlinkOverride: { current: undefined as ((path: string) => Promise<void> | undefined) | undefined },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: (path: Parameters<typeof actual.unlink>[0]) => {
      const override = unlinkOverride.current?.(String(path));
      return override !== undefined ? override : actual.unlink(path);
    },
  };
});

let home: string;
let dirs: SpoolDirs;

const session = (id: string): Session => ({
  id, cwd: '/x', project: 'x', origin: 'vscode',
  status: 'running', toolCount: 3, lastEventAt: 42,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  unlinkOverride.current = undefined;
});

describe('persist', () => {
  it('écrit puis relit une session', async () => {
    await writeSession(dirs, session('a'));
    const back = await readSessions(dirs);
    expect(back.get('a')).toEqual(session('a'));
  });

  it('ne laisse aucun fichier temporaire', async () => {
    await writeSession(dirs, session('a'));
    expect(readdirSync(dirs.sessions).filter((f) => f.startsWith('.tmp'))).toHaveLength(0);
  });

  it('supprime sans lever si le fichier est déjà absent', async () => {
    await expect(removeSession(dirs, 'jamais-vu')).resolves.toBeUndefined();
  });

  it('ignore un fichier de session illisible', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dirs.sessions, 'casse.json'), '{ pas du json');
    await writeSession(dirs, session('a'));
    const back = await readSessions(dirs);
    expect(back.size).toBe(1);
  });

  it('ignore un fichier de session partiellement conforme', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dirs.sessions, 'incomplet.json'),
      JSON.stringify({ id: 'b', status: 'idle', lastEventAt: 1 }),
    );
    await writeSession(dirs, session('a'));
    const back = await readSessions(dirs);
    expect(back.size).toBe(1);
    expect(back.get('a')).toEqual(session('a'));
    expect(back.has('b')).toBe(false);
  });

  it('ne laisse aucun fichier temporaire même pour des écritures concurrentes sans attente entre elles', async () => {
    // writeSession est exportée et réutilisable : sa sûreté ne doit pas dépendre
    // de la sérialisation qu'un appelant (SpoolWatcher.tick) lui impose par ailleurs.
    await Promise.all([
      writeSession(dirs, session('a')),
      writeSession(dirs, session('a')),
      writeSession(dirs, session('a')),
    ]);
    expect(readdirSync(dirs.sessions).filter((f) => f.startsWith('.tmp'))).toHaveLength(0);
    expect((await readSessions(dirs)).get('a')).toEqual(session('a'));
  });

  describe('readSession', () => {
    it('lit une seule session par id, sans passer par le répertoire entier', async () => {
      await writeSession(dirs, session('a'));
      await writeSession(dirs, session('b'));
      expect(await readSession(dirs, 'a')).toEqual(session('a'));
    });

    it('retourne undefined pour une session absente', async () => {
      expect(await readSession(dirs, 'jamais-vu')).toBeUndefined();
    });

    it('retourne undefined pour un fichier illisible', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dirs.sessions, 'casse.json'), '{ pas du json');
      expect(await readSession(dirs, 'casse')).toBeUndefined();
    });
  });

  describe('purgeStaleSessions', () => {
    it('supprime une session dont lastEventAt dépasse le seuil, laisse les autres', async () => {
      await writeSession(dirs, { ...session('vieille'), lastEventAt: 0 });
      await writeSession(dirs, { ...session('fraiche'), lastEventAt: 99_000 });

      const purged = await purgeStaleSessions(dirs, /* now */ 100_000, /* maxAgeMs */ 50_000);

      expect(purged).toEqual(['vieille']);
      const back = await readSessions(dirs);
      expect(back.has('vieille')).toBe(false);
      expect(back.has('fraiche')).toBe(true);
    });

    it('ne supprime rien avant le seuil', async () => {
      await writeSession(dirs, { ...session('a'), lastEventAt: 900 });
      const purged = await purgeStaleSessions(dirs, 1000, 50_000);
      expect(purged).toEqual([]);
      expect((await readSessions(dirs)).has('a')).toBe(true);
    });

    it('est idempotente et tolère qu une autre fenêtre ait déjà supprimé le fichier', async () => {
      await writeSession(dirs, { ...session('a'), lastEventAt: 0 });
      const first = await purgeStaleSessions(dirs, 100_000, 50_000);
      expect(first).toEqual(['a']);
      // Le fichier n'existe déjà plus : un second passage (une autre fenêtre,
      // ou le même drain rejoué) ne doit ni lever ni le reproposer.
      const second = await purgeStaleSessions(dirs, 100_000, 50_000);
      expect(second).toEqual([]);
    });

    it("ne supprime pas une session ravivée par une autre fenêtre pendant que la purge traite une autre session (N1)", async () => {
      // On met en pause la suppression de 's-early' — ce qui ne peut se
      // produire, dans n'importe quelle implémentation, qu'une fois toute
      // lecture préalable terminée. Pendant cette pause, une autre fenêtre
      // ravive 's-late'. Une purge qui décide à partir d'un instantané pris
      // avant cette pause (au lieu de relire juste avant de supprimer) la
      // supprime quand même.
      await writeSession(dirs, { ...session('s-early'), lastEventAt: 0 });
      await writeSession(dirs, { ...session('s-late'), lastEventAt: 0 });

      let triggered = false;
      let releaseGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let reachedGate: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        reachedGate = resolve;
      });
      const { unlink: realUnlink } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      unlinkOverride.current = (path) => {
        if (triggered || !path.endsWith('s-early.json')) return undefined;
        triggered = true;
        reachedGate();
        return gate.then(() => realUnlink(path));
      };

      const purgePromise = purgeStaleSessions(dirs, 100_000, 50_000);
      await reached;

      // Une autre fenêtre ravive s-late pendant que la purge est occupée sur s-early.
      await writeSession(dirs, { ...session('s-late'), lastEventAt: 100_000 });

      releaseGate();
      const purged = await purgePromise;
      unlinkOverride.current = undefined;

      expect(purged).toContain('s-early');
      expect(purged).not.toContain('s-late');
      expect((await readSessions(dirs)).has('s-late')).toBe(true);
    });
  });

  it('converge : deux ordres de lecture donnent le même état', () => {
    const mk = (event: SpoolEvent['event'], at: number, id: string): SpoolEvent => ({
      event, at, entrypoint: 'cli', termProgram: '', sessionId: id, cwd: '/x',
    });
    const events = [
      mk('SessionStart', 1, 'a'),
      mk('UserPromptSubmit', 2, 'a'),
      mk('PostToolUse', 3, 'a'),
      mk('Stop', 4, 'a'),
    ];
    const forward = reduceAll(events);
    const shuffled = reduceAll([events[2]!, events[0]!, events[3]!, events[1]!]);
    expect(shuffled.get('a')?.status).toBe(forward.get('a')?.status);
    expect(shuffled.get('a')?.toolCount).toBe(forward.get('a')?.toolCount);
  });
});
