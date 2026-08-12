import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions, writeSession } from '../src/spool/persist';
import { drain } from '../src/spool/watcher';
import { acknowledgeClickedSession, acknowledgeVisibleSessions } from '../src/focus/acknowledge';
import type { Session } from '../src/events/types';

// Aucun bouchon vscode nécessaire : ces deux fonctions ne prennent que des
// dossiers du spool et des chaînes (dirs, folders, id/cwd) en entrée — elles
// sont extraites d'onVisible et de focusSession (extension.ts) précisément
// pour rester testables à la frontière de composition, pas seulement au
// niveau de la primitive pure (sessionsToAcknowledge) qu'elles appellent. Un
// relecteur a prouvé par mutation que réintroduire le bug I6 exact
// directement dans extension.ts (acquitter sans filtrer par revendication, et
// ne pas acquitter au clic) compilait et laissait tous les tests verts tant
// que seule la primitive pure était couverte.

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'done_unseen',
  toolCount: 0,
  lastEventAt: 0,
  ...over,
});

let home: string;
let dirs: SpoolDirs;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-ack-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('acknowledgeVisibleSessions (I6, la moitié « vue affichée »)', () => {
  it('acquitte uniquement les sessions terminées non lues que ces dossiers revendiquent', async () => {
    await writeSession(dirs, session({ id: 'claimed', cwd: '/Users/dev/projet', status: 'done_unseen' }));
    await writeSession(dirs, session({ id: 'foreign', cwd: '/Users/dev/autre-projet', status: 'done_unseen' }));

    await acknowledgeVisibleSessions(dirs, ['/Users/dev/projet']);
    await drain(dirs, 1);

    const sessions = await readSessions(dirs);
    expect(sessions.get('claimed')?.status).toBe('idle'); // acquittée
    expect(sessions.get('foreign')?.status).toBe('done_unseen'); // pas revendiquée, pas touchée
  });

  it("n'acquitte pas une session revendiquée mais pas terminée non lue", async () => {
    await writeSession(dirs, session({ id: 'running', cwd: '/Users/dev/projet', status: 'running' }));

    await acknowledgeVisibleSessions(dirs, ['/Users/dev/projet']);
    await drain(dirs, 1);

    expect((await readSessions(dirs)).get('running')?.status).toBe('running');
  });

  it("n'acquitte rien sans dossier ouvert", async () => {
    await writeSession(dirs, session({ id: 'a', cwd: '/Users/dev/projet', status: 'done_unseen' }));

    await acknowledgeVisibleSessions(dirs, []);
    await drain(dirs, 1);

    expect((await readSessions(dirs)).get('a')?.status).toBe('done_unseen');
  });
});

describe('acknowledgeClickedSession (I6, la moitié « clic »)', () => {
  it('acquitte la session cliquée inconditionnellement, même si aucune fenêtre ne la revendique', async () => {
    await writeSession(dirs, session({ id: 's-cross', cwd: '/Users/dev/autre-projet', status: 'done_unseen' }));

    await acknowledgeClickedSession(dirs, { id: 's-cross', cwd: '/Users/dev/autre-projet' });
    await drain(dirs, 1);

    expect((await readSessions(dirs)).get('s-cross')?.status).toBe('idle');
  });

  it("un clic sur une session inconnue (déjà purgée) ne la recrée pas (I2, ordre respecté)", async () => {
    await acknowledgeClickedSession(dirs, { id: 'fantome', cwd: '/Users/dev/projet' });
    await drain(dirs, 1);

    expect((await readSessions(dirs)).has('fantome')).toBe(false);
  });
});
