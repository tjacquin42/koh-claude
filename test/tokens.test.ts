import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTokens } from '../src/transcript/tokens';
import type { Session } from '../src/events/types';
import type { TranscriptStats } from '../src/transcript/reader';

let dir: string;
let goodFile: string;
let brokenDir: string; // un dossier passé comme s'il était un fichier de transcript

const assistant = (input: number, output: number): string =>
  `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, output_tokens: output } } })}\n`;

const session = (id: string, transcriptPath: string): Session => ({
  id,
  cwd: '/x',
  project: 'x',
  origin: 'vscode',
  status: 'running',
  toolCount: 0,
  lastEventAt: 1,
  transcriptPath,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'koh-tokens-'));
  goodFile = join(dir, 'good.jsonl');
  brokenDir = join(dir, 'broken.jsonl'); // un vrai dossier : readTranscript lève EISDIR à la lecture
  await writeFile(goodFile, assistant(100, 20));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(brokenDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('withTokens', () => {
  it('isole les échecs par session : une session illisible ne prive pas les autres de leurs compteurs', async () => {
    const sessions = new Map<string, Session>([
      ['good', session('good', goodFile)],
      ['bad', session('bad', brokenDir)],
    ]);
    const onFailure = vi.fn();

    const out = await withTokens(sessions, new Map<string, TranscriptStats>(), onFailure);

    expect(out.get('good')?.tokens).toEqual({ input: 100, output: 20 });
    expect(out.get('bad')?.tokens).toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toBe(out.get('bad'));
  });

  it('ne lève jamais, même quand la seule session présente échoue', async () => {
    const sessions = new Map<string, Session>([['bad', session('bad', brokenDir)]]);
    await expect(withTokens(sessions, new Map<string, TranscriptStats>())).resolves.toBeDefined();
  });

  it('le rendu suivant fonctionne toujours : un second appel après un échec réussit encore, pour la session saine comme pour la fautive', async () => {
    const sessions = new Map<string, Session>([
      ['good', session('good', goodFile)],
      ['bad', session('bad', brokenDir)],
    ]);
    const transcripts = new Map<string, TranscriptStats>();
    const onFailure = vi.fn();

    await withTokens(sessions, transcripts, onFailure);
    // Deuxième « tick » sur le même état, comme le minuteur le ferait 2 s plus tard.
    const out = await withTokens(sessions, transcripts, onFailure);

    expect(out.get('good')?.tokens).toEqual({ input: 100, output: 20 });
    expect(out.get('bad')?.tokens).toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(2); // une fois par appel, jamais avalé
  });

  it('n appelle jamais onFailure pour une session sans transcript', async () => {
    const sessions = new Map<string, Session>([['idle', { ...session('idle', ''), transcriptPath: undefined }]]);
    const onFailure = vi.fn();
    await withTokens(sessions, new Map<string, TranscriptStats>(), onFailure);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
