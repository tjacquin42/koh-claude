import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTranscript, type TranscriptStats } from '../src/transcript/reader';

// `open` est mocké pour un seul test (M8) : il permet de simuler un `read()`
// qui renvoie moins d'octets que demandé (fichier tronqué entre `stat()` et
// `read()`) sans dépendre d'une vraie course contre le système de fichiers,
// donc piloté plutôt que chronométré. Délègue à l'implémentation réelle sauf
// quand ce test arme `openOverride`.
const { openOverride } = vi.hoisted(() => ({
  openOverride: {
    current: undefined as
      | (() => Promise<{
          stat: () => Promise<{ size: number }>;
          read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
          close: () => Promise<void>;
        }>)
      | undefined,
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1]) =>
      openOverride.current !== undefined ? openOverride.current() : actual.open(path, flags),
  };
});

let dir: string;
let file: string;

const assistant = (input: number, output: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/dev/projet',
    gitBranch: 'feat-seo',
    entrypoint: 'claude-vscode',
    isSidechain: false,
    message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 } },
  })}\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'koh-'));
  file = join(dir, 't.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  openOverride.current = undefined;
});

// Utilitaires pour les tests de titre : écrivent des lignes JSONL brutes dans
// le fichier temporaire du test courant, sans passer par le format des
// entrées `assistant` ci-dessus.
const fixture = async (lines: string[]): Promise<string> => {
  await writeFile(file, lines.map((l) => `${l}\n`).join(''));
  return file;
};

const appendLine = (path: string, line: string): Promise<void> => appendFile(path, `${line}\n`);

const rewrite = (path: string, lines: string[]): Promise<void> => writeFile(path, lines.map((l) => `${l}\n`).join(''));

describe('readTranscript', () => {
  it('somme les tokens et retient la branche', async () => {
    await writeFile(file, assistant(100, 20) + assistant(50, 5));
    const stats = await readTranscript(file);
    expect(stats.input).toBe(150);
    expect(stats.output).toBe(25);
    expect(stats.branch).toBe('feat-seo');
  });

  it('reprend là où elle s est arrêtée sans recompter', async () => {
    await writeFile(file, assistant(100, 20));
    const first = await readTranscript(file);
    await appendFile(file, assistant(7, 3));
    const second = await readTranscript(file, first);
    expect(second.input).toBe(107);
    expect(second.output).toBe(23);
  });

  it('ne consomme pas une ligne encore incomplète', async () => {
    await writeFile(file, `${assistant(10, 1)}{"type":"assist`);
    const stats = await readTranscript(file);
    expect(stats.input).toBe(10);
    // la ligne partielle sera relue au prochain passage
    await appendFile(file, `ant","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n`);
    const next = await readTranscript(file, stats);
    expect(next.input).toBe(15);
  });

  it('ignore les lignes non-assistant et les lignes illisibles', async () => {
    await writeFile(file, `{"type":"user"}\n{ cassé\n${assistant(9, 1)}`);
    const stats = await readTranscript(file);
    expect(stats.input).toBe(9);
    expect(stats.output).toBe(1);
  });

  it('retourne un état vide si le fichier n existe pas', async () => {
    const stats = await readTranscript('/nexiste/pas.jsonl');
    expect(stats).toEqual({ offset: 0, input: 0, output: 0 });
  });

  it('repart de zéro si le fichier a été remplacé par un plus court (rotation / nouvelle session)', async () => {
    const stale: TranscriptStats = {
      offset: 5000,
      input: 99999,
      output: 88888,
      branch: 'old-branch',
    };
    await writeFile(file, assistant(10, 20) + assistant(5, 5));
    const stats = await readTranscript(file, stale);
    expect(stats.input).toBe(15);
    expect(stats.output).toBe(25);
    expect(stats.branch).toBe('feat-seo');
    expect(stats.offset).toBeLessThan(stale.offset);
  });

  it("ne décode pas au-delà de bytesRead quand read() renvoie moins que ce qui a été demandé (M8)", async () => {
    // stat() ment sur la taille (comme si le fichier venait d'être tronqué
    // après le stat() réel mais avant le read()) : le buffer alloué est donc
    // plus grand que ce que read() remplit réellement. Le reste du buffer
    // contient, dans ce test, un fragment décodable d'un « ancien » transcript
    // — le pire cas plausible avec `allocUnsafe`, où la mémoire réutilisée est
    // un fragment d'une lecture précédente plutôt que du vrai hasard.
    const real = assistant(10, 1);
    const ghost = assistant(99999, 88888);
    const realLen = Buffer.byteLength(real, 'utf8');

    openOverride.current = () =>
      Promise.resolve({
        stat: () => Promise.resolve({ size: realLen + 5000 }),
        read: (buffer, offset, _length, _position) => {
          buffer.write(real, offset, 'utf8');
          buffer.write(ghost, offset + realLen, 'utf8');
          return Promise.resolve({ bytesRead: realLen });
        },
        close: () => Promise.resolve(undefined),
      });

    const stats = await readTranscript(file);

    expect(stats.input).toBe(10);
    expect(stats.output).toBe(1);
  });
});

describe('readTranscript — titre de la conversation', () => {
  it('retient le dernier ai-title vu', async () => {
    const p = await fixture(['{"type":"ai-title","aiTitle":"un"}', '{"type":"ai-title","aiTitle":"deux"}']);
    expect((await readTranscript(p)).title).toBe('deux');
  });

  it('customTitle prime sur ai-title, même écrit avant', async () => {
    const p = await fixture(['{"type":"custom-title","customTitle":"#à moi"}', '{"type":"ai-title","aiTitle":"engendré"}']);
    expect((await readTranscript(p)).title).toBe('#à moi');
  });

  it('pas de titre quand le transcript n en porte aucun', async () => {
    const p = await fixture(['{"type":"user","message":{"role":"user","content":"x"}}']);
    expect((await readTranscript(p)).title).toBeUndefined();
  });

  it('un titre vide ou fait d espaces ne compte pas', async () => {
    const p = await fixture(['{"type":"ai-title","aiTitle":"   "}']);
    expect((await readTranscript(p)).title).toBeUndefined();
  });

  it('conserve le titre au fil des lectures incrémentales', async () => {
    const p = await fixture(['{"type":"ai-title","aiTitle":"posé tôt"}']);
    const un = await readTranscript(p);
    await appendLine(p, '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1}}}');
    expect((await readTranscript(p, un)).title).toBe('posé tôt');
  });

  it('oublie le titre quand le transcript rétrécit', async () => {
    const p = await fixture(['{"type":"ai-title","aiTitle":"ancien"}']);
    const un = await readTranscript(p);
    // Rétrécit réellement en octets (16 < 39) : le contenu du brief
    // (`{"type":"user","message":{"role":"user","content":"neuf"}}`, 59
    // octets) est plus long que la ligne d'origine et ne déclenche donc pas
    // le mécanisme de reset existant, basé sur la taille du fichier.
    await rewrite(p, ['{"type":"user"}']);
    expect((await readTranscript(p, un)).title).toBeUndefined();
  });

  it('reprend le dernier customTitle sur un transcript réaliste (fixture titles.jsonl)', async () => {
    const stats = await readTranscript('test/fixtures/transcripts/titles.jsonl');
    expect(stats.title).toBe('#Mon titre');
  });
});
