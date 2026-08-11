import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSpoolFile } from '../src/events/parse';

const fixture = (name: string): string =>
  readFileSync(`test/fixtures/hooks/${name}.json`, 'utf8');

describe('parseSpoolFile', () => {
  it('normalise un PreToolUse réel', () => {
    const ev = parseSpoolFile(fixture('PreToolUse'));
    expect(ev?.event).toBe('PreToolUse');
    expect(ev?.sessionId).not.toBe('');
    expect(ev?.cwd).not.toBe('');
    expect(ev?.toolName).toBeDefined();
  });

  it('rejette un JSON invalide sans lever', () => {
    expect(parseSpoolFile('{ pas du json')).toBeUndefined();
  });

  it('rejette un événement inconnu', () => {
    expect(parseSpoolFile('{"event":"Inconnu","at":1,"payload":{}}')).toBeUndefined();
  });

  it('rejette un payload sans session_id', () => {
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"cwd":"/x"}}')).toBeUndefined();
  });

  it('tolère entrypoint et termProgram absents', () => {
    const ev = parseSpoolFile('{"event":"Stop","at":5,"payload":{"session_id":"s","cwd":"/x"}}');
    expect(ev?.entrypoint).toBe('');
    expect(ev?.at).toBe(5);
  });

  it('extrait la cible depuis tool_input', () => {
    const ev = parseSpoolFile(
      '{"event":"PreToolUse","at":1,"payload":{"session_id":"s","cwd":"/x","tool_name":"Edit","tool_input":{"file_path":"/x/a.ts"}}}',
    );
    expect(ev?.toolTarget).toBe('/x/a.ts');
  });
});
