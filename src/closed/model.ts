import { isValidSessionId } from '../events/parse';
import type { Origin } from '../events/types';

/**
 * How many closed conversations the section keeps. Deliberately fixed: a
 * setting would have to be shared between windows like everything else in
 * `~/.koh-vibe`, and nothing suggests five is the wrong number.
 */
export const MAX_CLOSED = 5;

/**
 * A conversation as it was when it ended — a frozen snapshot, not a reference.
 * Its session file is gone from `sessions/`, so whatever the row displays has
 * to be in here.
 *
 * What is deliberately absent: token counts, status, current action, pending
 * permission. Those are live states; frozen, they would show a dead
 * conversation as "writing".
 */
export interface ClosedEntry {
  id: string;
  cwd: string;
  project: string;
  branch?: string;
  title?: string;
  origin: Origin;
  closedAt: number;
}

export interface ClosedState {
  closed: readonly ClosedEntry[];
  /**
   * Top-level keys this version does not know, kept so that a file written by
   * a newer version survives a round trip through an older one. Same rule as
   * `GroupsState.unknown`.
   */
  unknown: Readonly<Record<string, unknown>>;
}

// Record<Origin, true> rather than a list: if the union gains a member in
// events/types.ts without this table being updated, compilation fails.
const ORIGINS: Record<Origin, true> = {
  vscode: true,
  terminal: true,
  desktop: true,
  sdk: true,
  unknown: true,
};

const KNOWN = new Set(['version', 'closed']);

export function emptyClosed(): ClosedState {
  return { closed: [], unknown: {} };
}

/**
 * Adds one close to the list. This is the ONLY mutation: nothing ever removes
 * an entry by hand, which is what keeps the concurrent write in `store.ts`
 * trivial — re-applying this on the freshest content IS the merge.
 *
 * Idempotent by construction: `cap` deduplicates by id, so replaying a
 * `SessionEnd` — which an abandoned drain or a second window can do — adds
 * nothing.
 */
export function remember(s: ClosedState, entry: ClosedEntry): ClosedState {
  return { ...s, closed: cap([entry, ...s.closed]) };
}

/**
 * The snapshot kept of a conversation that has just ended.
 *
 * Optional fields are omitted rather than written as `undefined`, so a round
 * trip through JSON does not leave dead keys behind — same rule as
 * `setGroupColor`.
 */
export function toClosedEntry(s: ClosedSource, closedAt: number): ClosedEntry {
  const entry: ClosedEntry = { id: s.id, cwd: s.cwd, project: s.project, origin: s.origin, closedAt };
  if (s.branch !== undefined) entry.branch = s.branch;
  if (s.title !== undefined) entry.title = s.title;
  return entry;
}

/**
 * Exactly what a snapshot needs from a live session — no more, so that the
 * model never has to import `Session` and its live fields.
 */
export type ClosedSource = Pick<ClosedEntry, 'id' | 'cwd' | 'project' | 'branch' | 'title' | 'origin'>;

function cap(entries: readonly ClosedEntry[]): ClosedEntry[] {
  const byId = new Map<string, ClosedEntry>();
  for (const e of entries) {
    const seen = byId.get(e.id);
    if (seen === undefined || e.closedAt > seen.closedAt) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_CLOSED);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// A type predicate rather than a cast: the value comes from a file nobody
// guarantees, and the compiler has to see it being checked.
function isOrigin(v: unknown): v is Origin {
  return typeof v === 'string' && v in ORIGINS;
}

/** An absent, unreadable or malformed file is an empty list: the view renders regardless. */
export function parseClosed(raw: string): ClosedState {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return emptyClosed();
  }
  if (!isRecord(root)) return emptyClosed();

  const closed: ClosedEntry[] = [];
  const rawClosed = root['closed'];
  if (Array.isArray(rawClosed)) {
    for (const e of rawClosed) {
      if (!isRecord(e)) continue;
      const id = text(e['id']);
      const cwd = text(e['cwd']);
      const project = text(e['project']);
      const origin = e['origin'];
      const closedAt = e['closedAt'];
      if (id === undefined || !isValidSessionId(id)) continue;
      if (cwd === undefined || project === undefined) continue;
      if (!isOrigin(origin)) continue;
      if (typeof closedAt !== 'number' || !Number.isFinite(closedAt)) continue;
      const entry: ClosedEntry = { id, cwd, project, origin, closedAt };
      const branch = text(e['branch']);
      if (branch !== undefined) entry.branch = branch;
      const title = text(e['title']);
      if (title !== undefined) entry.title = title;
      closed.push(entry);
    }
  }

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) if (!KNOWN.has(k)) unknown[k] = v;

  return { closed: cap(closed), unknown };
}

export function serializeClosed(s: ClosedState): string {
  return `${JSON.stringify({ ...s.unknown, version: 1, closed: s.closed }, null, 2)}\n`;
}
