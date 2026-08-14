import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGroups, type Group, type GroupsState, parseGroups, serializeGroups } from './model';

let seq = 0;

/** Un classement illisible ou absent vaut « vide » : la vue s'affiche quoi qu'il arrive. */
export async function readGroups(file: string): Promise<GroupsState> {
  try {
    return parseGroups(await readFile(file, 'utf8'));
  } catch {
    return emptyGroups();
  }
}

/**
 * Applique `fn` au classement et l'écrit. L'état est relu **à l'intérieur**, jamais
 * détenu par l'appelant au travers d'un `await` : une autre fenêtre peut avoir
 * classé entre-temps, et son travail ne doit pas être écrasé.
 */
export async function updateGroups(
  file: string,
  fn: (s: GroupsState) => GroupsState | Promise<GroupsState>,
): Promise<GroupsState> {
  const before = await readGroups(file);
  const after = await fn(before);
  // Relecture tardive : `fn` a pu prendre du temps, et le disque a pu bouger.
  const latest = await readGroups(file);
  const merged: GroupsState = {
    ...after,
    groups: mergeGroups(latest.groups, before.groups, after.groups),
    assignments: mergeAssignments(latest.assignments, before.assignments, after.assignments),
  };
  const tmp = join(dirname(file), `.tmp-groups-${process.pid}-${(seq += 1)}`);
  try {
    await writeFile(tmp, serializeGroups(merged), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return merged;
}

function mergeGroups(latest: readonly Group[], before: readonly Group[], after: readonly Group[]): Group[] {
  const added = after.filter((g) => !before.some((b) => b.id === g.id));
  const removed = new Set(before.filter((b) => !after.some((a) => a.id === b.id)).map((b) => b.id));
  const renamed = new Map(
    after.filter((a) => before.some((b) => b.id === a.id && b.name !== a.name)).map((a) => [a.id, a.name]),
  );
  const kept = latest
    .filter((g) => !removed.has(g.id))
    .map((g) => ({ ...g, name: renamed.get(g.id) ?? g.name }));
  const merged = [...kept, ...added.filter((g) => !kept.some((k) => k.id === g.id))];
  return merged.map((g, i) => ({ ...g, order: i }));
}

function mergeAssignments(
  latest: Readonly<Record<string, string>>,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...latest };
  for (const [sessionId, groupId] of Object.entries(after)) {
    if (before[sessionId] !== groupId) out[sessionId] = groupId;
  }
  for (const sessionId of Object.keys(before)) {
    if (after[sessionId] === undefined) delete out[sessionId];
  }
  return out;
}
