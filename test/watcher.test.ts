import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions } from '../src/spool/persist';
import { appendLocalEvent, drain, SpoolWatcher } from '../src/spool/watcher';

// `node:fs/promises` est un module natif : ses exports ne sont pas
// redéfinissables via vi.spyOn. On le mocke entièrement, en délégant à
// l'implémentation réelle sauf quand un test arme `unlinkOverride`.
const { unlinkOverride } = vi.hoisted(() => ({
  unlinkOverride: { current: undefined as ((path: string) => Promise<void>) | undefined },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: (path: Parameters<typeof actual.unlink>[0]) =>
      unlinkOverride.current !== undefined ? unlinkOverride.current(String(path)) : actual.unlink(path),
  };
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

let home: string;
let dirs: SpoolDirs;

async function dropEvent(name: string, body: unknown): Promise<void> {
  await writeFile(join(dirs.events, name), JSON.stringify(body), 'utf8');
}

const hook = (event: string, at: number, extra: Record<string, unknown> = {}) => ({
  event, at, entrypoint: 'cli', termProgram: '',
  payload: { session_id: 's1', cwd: '/Users/jack/DEV/pity-tidy', ...extra },
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('drain', () => {
  it('applique les événements, écrit l état, puis supprime le fichier', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await dropEvent('2-1-PreToolUse.json', hook('PreToolUse', 2, { tool_name: 'Bash' }));
    const res = await drain(dirs);
    expect(res.applied).toBe(2);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('running');
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('traite les fichiers dans l ordre de leur nom', async () => {
    await dropEvent('20-1-Stop.json', hook('Stop', 20));
    await dropEvent('10-1-UserPromptSubmit.json', hook('UserPromptSubmit', 10));
    await drain(dirs);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('done_unseen');
  });

  it('met de côté un fichier illisible sans bloquer les autres', async () => {
    await writeFile(join(dirs.events, '1-1-Casse.json'), '{ pas du json', 'utf8');
    await dropEvent('2-1-SessionStart.json', hook('SessionStart', 2));
    const res = await drain(dirs);
    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(1);
    expect(readdirSync(dirs.rejected)).toHaveLength(1);
  });

  it('retire la session sur SessionEnd', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await drain(dirs);
    await dropEvent('2-1-SessionEnd.json', hook('SessionEnd', 2));
    await drain(dirs);
    expect((await readSessions(dirs)).size).toBe(0);
  });

  it('ignore le fichier temporaire du bridge en cours d écriture', async () => {
    await writeFile(join(dirs.events, '.tmp-1-Stop'), '{"incomp', 'utf8');
    const res = await drain(dirs);
    expect(res.applied).toBe(0);
    expect(res.rejected).toBe(0);
  });

  it('appendLocalEvent produit un événement que drain sait lire', async () => {
    await dropEvent('1-1-Stop.json', hook('Stop', 1));
    await drain(dirs);
    await appendLocalEvent(dirs, { event: 'Ack', sessionId: 's1', cwd: '/Users/jack/DEV/pity-tidy' });
    await drain(dirs);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('idle');
  });

  it('appendLocalEvent concurrents (sans attente entre eux) produisent chacun un fichier distinct', async () => {
    // process.pid est constant sur toute la durée de vie du process de l'extension :
    // deux appels concurrents portant le même event ne doivent pas se marcher dessus.
    const calls = [
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's1', cwd: '/Users/jack/DEV/pity-tidy' }),
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's2', cwd: '/Users/jack/DEV/pity-tidy' }),
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's3', cwd: '/Users/jack/DEV/pity-tidy' }),
    ];
    await Promise.all(calls);

    const files = readdirSync(dirs.events).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(3);

    const sessionIds = new Set<string>();
    for (const name of files) {
      const raw = await readFile(join(dirs.events, name), 'utf8');
      const parsed = JSON.parse(raw) as { payload: { session_id: string } };
      sessionIds.add(parsed.payload.session_id);
    }
    expect(sessionIds).toEqual(new Set(['s1', 's2', 's3']));
  });
});

describe('drain — pannes de suppression', () => {
  afterEach(() => {
    unlinkOverride.current = undefined;
  });

  it('ignore silencieusement un unlink en échec ENOENT (déjà supprimé par une autre fenêtre)', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    unlinkOverride.current = () => Promise.reject(err);

    const res = await drain(dirs);
    unlinkOverride.current = undefined;

    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(0);
    expect(readdirSync(dirs.rejected)).toHaveLength(0);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
  });

  it('met de côté un événement dont la suppression échoue pour une vraie raison, pour éviter un double comptage', async () => {
    await dropEvent('1-1-PostToolUse.json', hook('PostToolUse', 1, { tool_name: 'Bash' }));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    unlinkOverride.current = () => Promise.reject(err);

    const res = await drain(dirs);
    unlinkOverride.current = undefined;

    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(1);
    expect(readdirSync(dirs.rejected).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    // Le fichier écarté ne peut plus être retraité : un second drain ne double
    // pas le compteur d'outils, qui est cumulatif.
    const res2 = await drain(dirs);
    expect(res2.applied).toBe(0);
    expect((await readSessions(dirs)).get('s1')?.toolCount).toBe(1);
  });
});

describe('SpoolWatcher', () => {
  it('start() tolère un dossier events absent, sans perdre la capacité de consommer ce qui arrive ensuite', async () => {
    const missingDirs = spoolDirs(join(home, 'pas-encore-cree'));
    const onChange = vi.fn();
    const watcher = new SpoolWatcher(missingDirs, onChange);

    expect(() => watcher.start()).not.toThrow();

    // Le dossier apparaît après coup (ex : ensureDirs appelé ailleurs), puis un événement y est déposé.
    await ensureDirs(missingDirs);
    await writeFile(
      join(missingDirs.events, '1-1-SessionStart.json'),
      JSON.stringify(hook('SessionStart', 1)),
      'utf8',
    );

    // Simule le tour de filet suivant sans attendre les 5 secondes réelles.
    await (watcher as unknown as { tick: () => Promise<void> }).tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await readSessions(missingDirs)).get('s1')?.startedAt).toBe(1);

    watcher.stop();
  });

  it('stop() ferme le FSWatcher et efface le minuteur de secours : plus aucun onChange après', async () => {
    const onChange = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange);
    watcher.start();

    try {
      const internal = watcher as unknown as {
        watcher?: { close: () => void };
        timer?: NodeJS.Timeout;
      };
      expect(internal.watcher).toBeDefined();
      expect(internal.timer).toBeDefined();
      const closeSpy = vi.spyOn(internal.watcher as { close: () => void }, 'close');

      // Avant stop() : un événement déposé est bien détecté et consommé.
      await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
      await waitFor(() => onChange.mock.calls.length > 0);
      expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);

      watcher.stop();

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(internal.watcher).toBeUndefined();
      expect(internal.timer).toBeUndefined();

      const callsAtStop = onChange.mock.calls.length;
      await dropEvent('2-1-Stop.json', hook('Stop', 2));
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(onChange.mock.calls.length).toBe(callsAtStop);
      // Le fichier déposé après stop() n'a pas été drainé.
      expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  it('la garde de non-réentrance ne fait perdre aucun fichier : un événement déposé pendant une vidange finit consommé', async () => {
    const onChange = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange);
    const internal = watcher as unknown as { running: boolean; tick: () => Promise<void> };

    // Simule une vidange déjà en cours.
    internal.running = true;
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));

    // Un déclenchement qui arrive pendant la vidange est un no-op : rien n'est perdu.
    await internal.tick();
    expect(onChange).not.toHaveBeenCalled();
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    // La vidange en cours se termine ; le prochain déclenchement retrouve le fichier.
    internal.running = false;
    await internal.tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});
