import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const BRIDGE = join(process.cwd(), 'bin/koh-claude-bridge');
let home: string;

function run(event: string, stdin: string, env: Record<string, string> = {}): number {
  const res = execFileSync(BRIDGE, [event], {
    input: stdin,
    env: { ...process.env, KOH_CLAUDE_HOME: home, ...env },
    encoding: 'utf8',
  });
  expect(res).toBe(''); // rien sur stdout, jamais
  return 0;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'koh-'));
});

describe('koh-claude-bridge', () => {
  it('dépose un fichier par événement, payload intact', () => {
    mkdirSync(join(home, 'events'), { recursive: true });
    run('PreToolUse', '{"session_id":"abc","cwd":"/tmp/p","tool_name":"Bash"}', {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERM_PROGRAM: 'ghostty',
    });
    const files = readdirSync(join(home, 'events')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const written: unknown = JSON.parse(readFileSync(join(home, 'events', files[0]!), 'utf8'));
    expect(written).toMatchObject({
      event: 'PreToolUse',
      entrypoint: 'cli',
      termProgram: 'ghostty',
      payload: { session_id: 'abc', cwd: '/tmp/p', tool_name: 'Bash' },
    });
  });

  it('ne laisse aucun fichier temporaire', () => {
    mkdirSync(join(home, 'events'), { recursive: true });
    run('Stop', '{"session_id":"abc","cwd":"/tmp/p"}');
    expect(readdirSync(join(home, 'events')).filter((f) => f.startsWith('.tmp'))).toHaveLength(0);
  });

  it('sort en 0 quand le spool n existe pas', () => {
    expect(run('Stop', '{"session_id":"abc","cwd":"/tmp/p"}')).toBe(0);
  });

  it('sort en 0 quand le spool est en lecture seule', () => {
    const events = join(home, 'events');
    mkdirSync(events, { recursive: true });
    chmodSync(events, 0o500);
    expect(run('Stop', '{"session_id":"abc","cwd":"/tmp/p"}')).toBe(0);
    chmodSync(events, 0o700);
  });
});
