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

  it('rejette un session_id qui contient un séparateur de chemin', () => {
    // "a/b" produit sessions/.tmp-a/b-<pid> côté writeSession → ENOENT. Un
    // identifiant de session doit être utilisable comme nom de fichier.
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"a/b","cwd":"/x"}}')).toBeUndefined();
  });

  it('rejette un session_id qui contient un antislash', () => {
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"a\\\\b","cwd":"/x"}}')).toBeUndefined();
  });

  it('rejette un session_id "." ou ".."', () => {
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":".","cwd":"/x"}}')).toBeUndefined();
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"..","cwd":"/x"}}')).toBeUndefined();
  });

  it('accepte un session_id ordinaire', () => {
    const ev = parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"abc-123_XYZ","cwd":"/x"}}');
    expect(ev?.sessionId).toBe('abc-123_XYZ');
  });
});
