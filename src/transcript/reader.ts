import { open } from 'node:fs/promises';

export interface TranscriptStats {
  offset: number;
  input: number;
  output: number;
  cacheRead: number;
  assistantTurns: number;
  branch?: string;
  entrypoint?: string;
}

const EMPTY: TranscriptStats = { offset: 0, input: 0, output: 0, cacheRead: 0, assistantTurns: 0 };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lit un transcript JSONL depuis `from.offset`. L'offset n'avance que jusqu'au
 * dernier saut de ligne : une ligne encore en cours d'écriture est relue au
 * passage suivant plutôt que comptée à moitié.
 */
export async function readTranscript(path: string, from?: TranscriptStats): Promise<TranscriptStats> {
  const start = from ?? EMPTY;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { ...start };
  }

  try {
    const { size } = await handle.stat();
    if (size <= start.offset) return { ...start, offset: Math.min(start.offset, size) };

    const length = size - start.offset;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start.offset);
    const chunk = buffer.toString('utf8');

    const lastBreak = chunk.lastIndexOf('\n');
    if (lastBreak < 0) return { ...start };

    const stats: TranscriptStats = { ...start, offset: start.offset + Buffer.byteLength(chunk.slice(0, lastBreak + 1), 'utf8') };

    for (const line of chunk.slice(0, lastBreak).split('\n')) {
      if (line.length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;

      const branch = entry['gitBranch'];
      if (typeof branch === 'string' && branch.length > 0) stats.branch = branch;
      const entrypoint = entry['entrypoint'];
      if (typeof entrypoint === 'string' && entrypoint.length > 0) stats.entrypoint = entrypoint;

      if (entry['type'] !== 'assistant') continue;
      const message = entry['message'];
      if (!isRecord(message)) continue;
      const usage = message['usage'];
      if (!isRecord(usage)) continue;

      stats.assistantTurns += 1;
      stats.input += num(usage['input_tokens']);
      stats.output += num(usage['output_tokens']);
      stats.cacheRead += num(usage['cache_read_input_tokens']);
    }

    return stats;
  } finally {
    await handle.close();
  }
}
