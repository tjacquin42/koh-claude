import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { emptyGroups, type Group, type GroupsState, parseGroups, serializeGroups } from './model';

let seq = 0;

/**
 * Nombre maximal de TOURS DE FUSION tentés (relire → fusionner → écrire → vérifier). Ne borne
 * jamais le nombre de VÉRIFICATIONS : chaque tour, sans exception, relit juste avant de
 * renommer. Si les `MAX_ATTEMPTS` tours ont tous vu un changement, un dernier tour fusionne
 * l'état le plus frais et l'écrit sans relire une fois de plus — on sort de la boucle en ayant
 * fusionné le plus récent, jamais en ignorant ce qu'on vient de lire.
 */
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
 *
 * La file ne reste jamais bloquée par un appel qui échoue : `run` peut rejeter (l'appelant de
 * `updateGroups` reçoit l'erreur), mais l'entrée posée dans `queues` pour le PROCHAIN appel est
 * dérivée d'une version de `run` dont le rejet est absorbé (`.then(ok, ok)`) — le prochain
 * appel démarre donc quoi qu'il soit arrivé au précédent.
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
 * 2. `updateGroupsOnce` relit toujours juste avant de renommer, à chaque tour de fusion, sans
 *    exception ; si le fichier a changé depuis la fusion (une AUTRE fenêtre a écrit
 *    entre-temps), la fusion est rejouée à partir du nouveau contenu plutôt que d'écraser ce
 *    changement — jusqu'à `MAX_ATTEMPTS` tours, le dernier fusionnant et écrivant l'état le
 *    plus frais sans relire une fois de plus.
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
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const merged = merge(latestRaw, before, after);
    const freshRaw = await writeIfUnchanged(file, merged, latestRaw);
    if (freshRaw === undefined) return merged;
    latestRaw = freshRaw;
  }

  // Budget de tours de fusion épuisé : les `MAX_ATTEMPTS` relectures ont toutes vu un
  // changement (contention réelle et soutenue). On ne relit pas une fois de plus — on
  // fusionnerait à l'infini sans jamais commettre — mais `latestRaw` est déjà le contenu le
  // plus frais qu'on ait observé : ce dernier tour fusionne CET état, puis écrit sans nouvelle
  // vérification.
  const merged = merge(latestRaw, before, after);
  await writeUnconditionally(file, merged);
  return merged;
}

function merge(latestRaw: string | undefined, before: GroupsState, after: GroupsState): GroupsState {
  const latest = toState(latestRaw);
  return {
    ...after,
    groups: mergeGroups(latest.groups, before.groups, after.groups),
    assignments: mergeAssignments(latest.assignments, before.assignments, after.assignments),
    sessionOrder: mergeSessionOrder(latest.sessionOrder, before.sessionOrder, after.sessionOrder),
    // Même règle, même raison que les affectations : régler le son d'UNE
    // conversation ne doit pas effacer celui qu'une autre fenêtre vient de poser
    // sur une autre.
    sessionSounds: mergeAssignments(latest.sessionSounds, before.sessionSounds, after.sessionSounds),
  };
}

/**
 * Écrit `merged` dans un fichier temporaire, relit le fichier cible, et ne renomme que si son
 * contenu est encore celui attendu (`expectedRaw`). Retourne `undefined` si le renommage a eu
 * lieu (fusion commise), ou le contenu frais sinon (l'appelant doit refusionner avec).
 */
async function writeIfUnchanged(
  file: string,
  merged: GroupsState,
  expectedRaw: string | undefined,
): Promise<string | undefined> {
  const tmp = tmpPath(file);
  try {
    await writeFile(tmp, serializeGroups(merged), 'utf8');
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

async function writeUnconditionally(file: string, merged: GroupsState): Promise<void> {
  const tmp = tmpPath(file);
  try {
    await writeFile(tmp, serializeGroups(merged), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function tmpPath(file: string): string {
  return join(dirname(file), `.tmp-groups-${process.pid}-${(seq += 1)}`);
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

/** L'ordre n'en fait pas partie : il est recalculé à la fin de la fusion. */
function sameAttributes(a: Group, b: Group): boolean {
  return a.name === b.name && a.color === b.color && a.sound === b.sound;
}

/**
 * Pose sur le dossier le plus frais les attributs de notre édition. Une couleur
 * retirée retire la clé plutôt que d'écrire `undefined` — même règle que
 * `setGroupColor` (model.ts), pour qu'un aller-retour par le fichier ne laisse
 * pas de clé morte derrière lui.
 */
function applyEdit(target: Group, edit: Group): Group {
  const { color: _color, sound: _sound, ...rest } = target;
  const merged: Group = { ...rest, name: edit.name };
  if (edit.color !== undefined) merged.color = edit.color;
  if (edit.sound !== undefined) merged.sound = edit.sound;
  return merged;
}

function mergeGroups(latest: readonly Group[], before: readonly Group[], after: readonly Group[]): Group[] {
  const added = after.filter((g) => !before.some((b) => b.id === g.id));
  const removed = new Set(before.filter((b) => !after.some((a) => a.id === b.id)).map((b) => b.id));
  // Les dossiers conservés viennent de `latest` — l'état le plus frais, qui peut
  // contenir le travail d'une autre fenêtre — et ne reçoivent de NOTRE édition
  // que les attributs qu'elle a réellement changés. Ne propager que le nom, comme
  // le faisait ce code, perdait en silence tout autre attribut : une couleur
  // posée disparaissait à l'écriture. `sameAttributes` est donc la liste, à tenir
  // à jour, de ce qu'un dossier porte et qu'une fenêtre peut modifier.
  const edited = new Map(
    after.filter((a) => before.some((b) => b.id === a.id && !sameAttributes(b, a))).map((a) => [a.id, a] as const),
  );
  const kept = latest
    .filter((g) => !removed.has(g.id))
    .map((g) => {
      const edit = edited.get(g.id);
      return edit === undefined ? g : applyEdit(g, edit);
    });
  const merged = [...kept, ...added.filter((g) => !kept.some((k) => k.id === g.id))];
  return merged.map((g, i) => ({ ...g, order: i }));
}

/**
 * Fusionne les ordres dossier par dossier, jamais en bloc : ranger dans SON
 * dossier ne doit pas effacer l'ordre qu'une autre fenêtre vient de poser dans
 * un AUTRE. Prendre `after.sessionOrder` tel quel, comme le faisait la première
 * version, écrasait tout le reste — le même défaut que la couleur perdue par
 * mergeGroups, à un champ près.
 *
 * Un ordre qu'on n'a pas touché revient de `latest` (l'état le plus frais) ;
 * celui qu'on a changé est le nôtre ; celui qu'on a vidé disparaît.
 */
function mergeSessionOrder(
  latest: Readonly<Record<string, readonly string[]>>,
  before: Readonly<Record<string, readonly string[]>>,
  after: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = { ...latest };
  for (const [key, ids] of Object.entries(after)) {
    if (!sameIds(before[key], ids)) out[key] = ids;
  }
  for (const key of Object.keys(before)) {
    if (after[key] === undefined) delete out[key];
  }
  return out;
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
