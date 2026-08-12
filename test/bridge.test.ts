import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
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

  it('zero-padde le pid dans le nom de fichier, pour que le tri lexicographique ne dépende pas de sa largeur', () => {
    // Deux événements de la même milliseconde ne sont distingués que par le
    // tri du nom de fichier une fois le champ horodatage égal ; un pid non
    // zero-paddé trie "9" après "10" alors que 9 < 10. Un pid de largeur fixe
    // ferme cette ambiguïté, quelle que soit la valeur réelle du pid.
    mkdirSync(join(home, 'events'), { recursive: true });
    run('Stop', '{"session_id":"abc","cwd":"/tmp/p"}');
    const files = readdirSync(join(home, 'events')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const match = /^\d{13}-(\d+)-Stop\.json$/.exec(files[0]!);
    expect(match).not.toBeNull();
    expect(match?.[1]).toHaveLength(10);
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

  it("ne perturbe jamais la session Claude Code qui l'appelle : rien sur stderr même quand le spool n'est pas inscriptible (M1)", () => {
    // execFileSync ne donne accès à stderr qu'en cas d'échec : spawnSync le
    // capture toujours, sans dépendre du code de retour.
    const events = join(home, 'events');
    mkdirSync(events, { recursive: true });
    chmodSync(events, 0o500);
    const res = spawnSync(BRIDGE, ['Stop'], {
      input: '{"session_id":"abc","cwd":"/tmp/p"}',
      env: { ...process.env, KOH_CLAUDE_HOME: home },
      encoding: 'utf8',
    });
    chmodSync(events, 0o700);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });
});
