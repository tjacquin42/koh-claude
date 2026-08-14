import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BRIDGE = join(process.cwd(), 'bin/koh-claude-statusline');
const PAYLOAD = '{"rate_limits":{"five_hour":{"used_percentage":78,"resets_at":1786297800}}}';

let home: string;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function run(stdin: string, arg?: string): string {
  return execFileSync(BRIDGE, arg === undefined ? [] : [arg], {
    input: stdin,
    env: { ...process.env, KOH_CLAUDE_HOME: home },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'koh-sl-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('koh-claude-statusline', () => {
  it('dépose l instantané tel quel, sans l interpréter', () => {
    expect(run(PAYLOAD)).toBe('');
    expect(readFileSync(join(home, 'status.json'), 'utf8')).toBe(PAYLOAD);
  });

  it('n écrit rien de son propre chef sur stdout — ce flux appartient à la statusline', () => {
    expect(run(PAYLOAD)).toBe('');
  });

  it('laisse passer la sortie du délégué, et lui repasse la MÊME entrée', () => {
    const out = run(PAYLOAD, b64(`/usr/bin/head -c 12`));
    expect(out).toBe(PAYLOAD.slice(0, 12));
    // Et l instantané a bien été capté au passage.
    expect(readFileSync(join(home, 'status.json'), 'utf8')).toBe(PAYLOAD);
  });

  it('survit à un délégué qui échoue, sans rien renvoyer de bruyant', () => {
    expect(run(PAYLOAD, b64('/bin/sh -c "exit 3"'))).toBe('');
    expect(existsSync(join(home, 'status.json'))).toBe(true);
  });

  it('accepte un délégué dont la commande contient guillemets et apostrophes', () => {
    const script = join(home, 'delegue.sh');
    writeFileSync(script, '#!/bin/sh\necho "il a dit: \'salut\'"\n', 'utf8');
    chmodSync(script, 0o755);
    expect(run(PAYLOAD, b64(`'${script}'`)).trim()).toBe("il a dit: 'salut'");
  });

  it('ne laisse aucun fichier temporaire derrière lui', () => {
    run(PAYLOAD);
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(home).filter((f) => f.startsWith('.tmp'))).toEqual([]);
  });

  it('ne crée rien quand le dossier d état n existe pas', () => {
    rmSync(home, { recursive: true, force: true });
    expect(run(PAYLOAD)).toBe('');
    expect(existsSync(join(home, 'status.json'))).toBe(false);
    home = mkdtempSync(join(tmpdir(), 'koh-sl-'));
  });

  it('n écrase pas un instantané valide par du vide', () => {
    run(PAYLOAD);
    run('');
    expect(readFileSync(join(home, 'status.json'), 'utf8')).toBe(PAYLOAD);
  });
});
