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

  it("rejette un session_id contenant un octet NUL (N3 : liste blanche, pas une liste de caractères interdits)", () => {
    // L'octet NUL franchit une validation qui ne raisonnerait que par liste noire
    // ('/', '\', '.', '..') : il ne figure dans aucune de ces exclusions, et
    // pourtant reste inutilisable dans un nom de fichier. La frontière doit
    // dire ce qui EST permis, pas énumérer ce qui ne l'est pas.
    expect(
      parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"a\\u0000b","cwd":"/x"}}'),
    ).toBeUndefined();
  });

  it('rejette un session_id contenant un espace ou un caractère exotique quelconque', () => {
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"a b","cwd":"/x"}}')).toBeUndefined();
    expect(parseSpoolFile('{"event":"Stop","at":1,"payload":{"session_id":"a✨b","cwd":"/x"}}')).toBeUndefined();
  });

  // M2, corrigé à la frontière plutôt que chez un lecteur : targetOf() tronquait
  // déjà tool_input.command à 80 caractères mais ne normalisait pas les blancs,
  // et pendingPermission.summary (store/reduce.ts) partage exactement cette
  // même source (ev.toolTarget) — un second lecteur qui aurait fallu penser à
  // corriger séparément si la normalisation était restée côté affichage.
  it("normalise les blancs (dont les retours à la ligne) d'une commande Bash multi-ligne extraite de tool_input", () => {
    const raw = JSON.stringify({
      event: 'PreToolUse',
      at: 1,
      payload: {
        session_id: 's',
        cwd: '/x',
        tool_name: 'Bash',
        tool_input: { command: 'node -e "\nconst fs = require(\'fs\')\nconsole.log(fs)"' },
      },
    });
    const ev = parseSpoolFile(raw);
    expect(ev?.toolTarget).toBe('node -e " const fs = require(\'fs\') console.log(fs)"');
  });

  it('normalise la même commande multi-ligne quand elle arrive via un PermissionRequest (repro exacte du défaut observé)', () => {
    const raw = JSON.stringify({
      event: 'PermissionRequest',
      at: 1,
      payload: {
        session_id: 's',
        cwd: '/x',
        tool_name: 'Bash',
        tool_input: { command: "node -e \"\nconst fs=require('fs')\n…\"" },
      },
    });
    const ev = parseSpoolFile(raw);
    expect(ev?.toolTarget).not.toMatch(/\n/);
    expect(ev?.toolTarget).toBe("node -e \" const fs=require('fs') …\"");
  });

  it('normalise aussi les blancs du champ message (second repli de pendingPermission.summary)', () => {
    const raw = JSON.stringify({
      event: 'PermissionRequest',
      at: 1,
      payload: { session_id: 's', cwd: '/x', message: 'ligne 1\nligne 2' },
    });
    const ev = parseSpoolFile(raw);
    expect(ev?.message).toBe('ligne 1 ligne 2');
  });

  it("ignore une valeur de tool_input qui ne contient que des blancs et retombe sur la clé suivante", () => {
    const raw = JSON.stringify({
      event: 'PreToolUse',
      at: 1,
      payload: {
        session_id: 's',
        cwd: '/x',
        tool_name: 'Read',
        tool_input: { file_path: '   ', path: '/real/path' },
      },
    });
    const ev = parseSpoolFile(raw);
    expect(ev?.toolTarget).toBe('/real/path');
  });
});
