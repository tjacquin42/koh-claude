import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions, removeSession, writeSession } from '../src/spool/persist';
import { reduceAll } from '../src/store/reduce';
import type { Session, SpoolEvent } from '../src/events/types';

let dirs: SpoolDirs;

const session = (id: string): Session => ({
  id, cwd: '/x', project: 'x', origin: 'vscode',
  status: 'running', toolCount: 3, lastEventAt: 42,
});

beforeEach(async () => {
  dirs = spoolDirs(mkdtempSync(join(tmpdir(), 'koh-')));
  await ensureDirs(dirs);
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
