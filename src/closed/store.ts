import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ClosedEntry,
  type ClosedState,
  emptyClosed,
  parseClosed,
  remember,
  serializeClosed,
} from './model';

let seq = 0;

/**
 * Maximum number of MERGE ROUNDS attempted (re-read → merge → write → check).
 * Never bounds the number of CHECKS: every round, without exception, re-reads
 * just before renaming. If all `MAX_ATTEMPTS` rounds saw a change, one last
 * round merges the freshest state and writes it without reading once more —
 * we leave the loop having merged the latest content, never by ignoring what
 * we just read.
 */
const MAX_ATTEMPTS = 3;

/** An absent, unreadable or malformed file is an empty list: the view renders regardless. */
export async function readClosed(file: string): Promise<ClosedState> {
  return toState(await readRaw(file));
}

/**
 * Serialises calls to `rememberClosed` on one file WITHIN THIS PROCESS: two
 * calls started from the same window (e.g. closing several conversations at
 * once) never run concurrently with each other, the second waits for the
 * first. Does not protect against ANOTHER window (another process):
 * `rememberOnce` handles that with its own re-read just before renaming.
 *
 * The queue never stays stuck on a failing call: `run` can reject (the caller
 * of `rememberClosed` receives the error), but the entry stored in `queues`
 * for the NEXT call is derived from a version of `run` whose rejection is
 * absorbed (`.then(ok, ok)`) — so the next call starts regardless of what
 * happened to the previous one.
 */
const queues = new Map<string, Promise<void>>();

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const settled = previous.then(
    () => undefined,
    () => undefined,
  );
  const run = settled.then(task);
  queues.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Archives one close.
 *
 * There is no three-way merge here, unlike the folders in `groups/store.ts`:
 * a folder assignment can be *deleted*, so that merge needs `before` (what we
 * read) and `after` (what we computed) to tell "this key is gone because I
 * removed it" apart from "I never saw it". Here nothing ever deletes an
 * entry — `remember` only ever adds one and caps the list — so re-applying
 * `remember` to the freshest content IS the union the spec asks for. The
 * state before our edit would only matter for that deletion distinction,
 * which this file has no way to produce in the first place.
 */
export function rememberClosed(file: string, entry: ClosedEntry): Promise<ClosedState> {
  return enqueue(file, () => rememberOnce(file, entry));
}

async function rememberOnce(file: string, entry: ClosedEntry): Promise<ClosedState> {
  let latestRaw = await readRaw(file);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const merged = remember(toState(latestRaw), entry);
    const freshRaw = await writeIfUnchanged(file, merged, latestRaw);
    if (freshRaw === undefined) return merged;
    latestRaw = freshRaw;
  }
  // Round budget spent: all `MAX_ATTEMPTS` re-reads saw a change (real,
  // sustained contention). We don't re-read once more — we'd merge forever
  // without ever committing — but `latestRaw` is already the freshest content
  // we observed: this last round merges THAT state, then writes without
  // checking again.
  const merged = remember(toState(latestRaw), entry);
  await writeUnconditionally(file, merged);
  return merged;
}

/**
 * Writes to a temporary file, re-reads the target, and renames only if its
 * content is still the expected one. Returns `undefined` once the rename
 * happened, or the fresh content the caller must merge against.
 */
async function writeIfUnchanged(
  file: string,
  merged: ClosedState,
  expectedRaw: string | undefined,
): Promise<string | undefined> {
  const tmp = tmpPath(file);
  try {
    await writeFile(tmp, serializeClosed(merged), 'utf8');
    const checkRaw = await readRaw(file);
    if (checkRaw === expectedRaw) {
      await rename(tmp, file);
      return undefined;
    }
    await unlink(tmp).catch(() => undefined);
    return checkRaw;
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function writeUnconditionally(file: string, merged: ClosedState): Promise<void> {
  const tmp = tmpPath(file);
  try {
    await writeFile(tmp, serializeClosed(merged), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function tmpPath(file: string): string {
  return join(dirname(file), `.tmp-closed-${process.pid}-${(seq += 1)}`);
}

function toState(raw: string | undefined): ClosedState {
  return raw === undefined ? emptyClosed() : parseClosed(raw);
}

async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
