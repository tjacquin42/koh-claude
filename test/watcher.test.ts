import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions } from '../src/spool/persist';
import { appendLocalEvent, drain } from '../src/spool/watcher';

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
});
