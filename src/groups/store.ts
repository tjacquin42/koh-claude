import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGroups, type Group, type GroupsState, parseGroups, serializeGroups } from './model';

let seq = 0;

/** Nombre maximal de fusions tentées avant d'écrire malgré un changement détecté. */
const MAX_ATTEMPTS = 3;

/** Un classement illisible ou absent vaut « vide » : la vue s'affiche quoi qu'il arrive. */
export async function readGroups(file: string): Promise<GroupsState> {
  return toState(await readRaw(file));
}

/**
 * Sérialise les appels à `updateGroups` sur un même fichier **à l'intérieur de ce processus** :
 * deux appels lancés depuis la même fenêtre (ex. un glisser-déposer de plusieurs sessions d'un
 * coup) ne s'exécutent jamais en parallèle l'un de l'autre, le second attend la fin du premier.
 * Ne protège pas contre une AUTRE fenêtre (un autre processus) : `updateGroupsOnce` s'en charge
 * par sa propre relecture juste avant de renommer.
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
 * Applique `fn` au classement et l'écrit. L'état est relu **à l'intérieur**, jamais détenu par
 * l'appelant au travers d'un `await` : une autre fenêtre peut avoir classé entre-temps, et son
 * travail ne doit pas être écrasé.
 *
 * Deux mécanismes, pas un — voir task-5-report.md pour la mesure et la fenêtre résiduelle que
 * ni l'un ni l'autre ne referme complètement :
 * 1. `enqueue` : deux appels sur le même fichier depuis CE processus ne courent jamais l'un
 *    contre l'autre.
 * 2. Une nouvelle tentative bornée dans `updateGroupsOnce` : juste avant de renommer, on relit
 *    une dernière fois ; si le fichier a changé depuis la fusion (une AUTRE fenêtre a écrit
 *    entre-temps), on refait la fusion à partir du nouveau contenu plutôt que d'écraser ce
 *    changement — jusqu'à `MAX_ATTEMPTS` tentatives, puis on écrit malgré tout.
 */
export function updateGroups(
  file: string,
  fn: (s: GroupsState) => GroupsState | Promise<GroupsState>,
): Promise<GroupsState> {
  return enqueue(file, () => updateGroupsOnce(file, fn));
}

async function updateGroupsOnce(
  file: string,
  fn: (s: GroupsState) => GroupsState | Promise<GroupsState>,
): Promise<GroupsState> {
  const before = toState(await readRaw(file));
  const after = await fn(before);

  let latestRaw = await readRaw(file);
  for (let attempt = 1; ; attempt++) {
    const latest = toState(latestRaw);
    const merged: GroupsState = {
      ...after,
      groups: mergeGroups(latest.groups, before.groups, after.groups),
      assignments: mergeAssignments(latest.assignments, before.assignments, after.assignments),
    };
    const tmp = join(dirname(file), `.tmp-groups-${process.pid}-${(seq += 1)}`);
    try {
      await writeFile(tmp, serializeGroups(merged), 'utf8');
      // Dernière relecture avant de renommer : si personne d'autre n'a écrit depuis `latest`,
      // on commet. Sinon on refait la fusion à partir de ce nouveau contenu plutôt que
      // d'écraser un changement qu'on vient de voir. Rétrécit la course, ne la ferme pas : entre
      // CETTE lecture et le `rename` qui suit immédiatement, une autre écriture reste possible
      // en théorie (fenêtre résiduelle documentée dans task-5-report.md).
      const checkRaw = attempt < MAX_ATTEMPTS ? await readRaw(file) : latestRaw;
      if (checkRaw === latestRaw) {
        await rename(tmp, file);
        return merged;
      }
      await unlink(tmp).catch(() => undefined);
      latestRaw = checkRaw;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

function toState(raw: string | undefined): GroupsState {
  return raw === undefined ? emptyGroups() : parseGroups(raw);
}

async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
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
