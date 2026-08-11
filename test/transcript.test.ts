import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTranscript, type TranscriptStats } from '../src/transcript/reader';

let dir: string;
let file: string;

const assistant = (input: number, output: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/Users/jack/DEV/pity-tidy',
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
});

describe('readTranscript', () => {
  it('somme les tokens et retient la branche', async () => {
    await writeFile(file, assistant(100, 20) + assistant(50, 5));
    const stats = await readTranscript(file);
    expect(stats.input).toBe(150);
    expect(stats.output).toBe(25);
    expect(stats.cacheRead).toBe(20);
    expect(stats.assistantTurns).toBe(2);
    expect(stats.branch).toBe('feat-seo');
    expect(stats.entrypoint).toBe('claude-vscode');
  });

  it('reprend là où elle s est arrêtée sans recompter', async () => {
    await writeFile(file, assistant(100, 20));
    const first = await readTranscript(file);
    await appendFile(file, assistant(7, 3));
    const second = await readTranscript(file, first);
    expect(second.input).toBe(107);
    expect(second.output).toBe(23);
    expect(second.assistantTurns).toBe(2);
  });

  it('ne consomme pas une ligne encore incomplète', async () => {
    await writeFile(file, `${assistant(10, 1)}{"type":"assist`);
    const stats = await readTranscript(file);
    expect(stats.assistantTurns).toBe(1);
    // la ligne partielle sera relue au prochain passage
    await appendFile(file, `ant","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n`);
    const next = await readTranscript(file, stats);
    expect(next.assistantTurns).toBe(2);
    expect(next.input).toBe(15);
  });

  it('ignore les lignes non-assistant et les lignes illisibles', async () => {
    await writeFile(file, `{"type":"user"}\n{ cassé\n${assistant(9, 1)}`);
    const stats = await readTranscript(file);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.input).toBe(9);
  });

  it('retourne un état vide si le fichier n existe pas', async () => {
    const stats = await readTranscript('/nexiste/pas.jsonl');
    expect(stats).toEqual({ offset: 0, input: 0, output: 0, cacheRead: 0, assistantTurns: 0 });
  });

  it('repart de zéro si le fichier a été remplacé par un plus court (rotation / nouvelle session)', async () => {
    const stale: TranscriptStats = {
      offset: 5000,
      input: 99999,
      output: 88888,
      cacheRead: 77777,
      assistantTurns: 42,
      branch: 'old-branch',
      entrypoint: 'old-entrypoint',
    };
    await writeFile(file, assistant(10, 20) + assistant(5, 5));
    const stats = await readTranscript(file, stale);
    expect(stats.input).toBe(15);
    expect(stats.output).toBe(25);
    expect(stats.assistantTurns).toBe(2);
    expect(stats.branch).toBe('feat-seo');
    expect(stats.offset).toBeLessThan(stale.offset);
  });
});
