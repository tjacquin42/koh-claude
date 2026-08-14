export interface Group {
  id: string;
  name: string;
  order: number;
  /**
   * Identifiant de couleur, neutre et stable (« blue », « green »…), jamais un
   * libellé traduit ni une valeur de thème : le fichier est partagé entre
   * éditeurs et doit survivre à un changement de palette comme à un changement
   * de langue. La correspondance vers une couleur réelle vit dans ui/colors.ts,
   * et une valeur inconnue s'y affiche sans couleur au lieu de casser la vue.
   */
  color?: string;
}

export interface GroupsState {
  groups: readonly Group[];
  assignments: Readonly<Record<string, string>>;
  /**
   * L'ordre choisi à la main, dossier par dossier. Une clé absente veut dire
   * « aucun ordre choisi » : le dossier retombe alors sur le tri du tableau de
   * bord (statut puis fraîcheur). Dès qu'un ordre existe, il fait loi, et les
   * sessions qu'il ne nomme pas viennent après.
   *
   * La clé `UNFILED` (chaîne vide) désigne « Sans dossier » : `parseGroups`
   * refuse tout identifiant vide, donc aucun vrai dossier ne peut la revendiquer.
   */
  sessionOrder: Readonly<Record<string, readonly string[]>>;
  /** Champs du fichier que nous ne connaissons pas : préservés tels quels à l'écriture. */
  unknown: Readonly<Record<string, unknown>>;
}

const KNOWN = new Set(['version', 'groups', 'assignments', 'sessionOrder']);

/** La clé d'ordre de « Sans dossier ». */
export const UNFILED = '';

export function emptyGroups(): GroupsState {
  return { groups: [], assignments: {}, sessionOrder: {}, unknown: {} };
}

/** `undefined` (« Sans dossier ») et la chaîne vide désignent le même seau. */
export function orderKey(groupId: string | undefined): string {
  return groupId ?? UNFILED;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function name(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Une donnée illisible vaut « aucun classement » : la vue doit s'afficher quoi qu'il arrive. */
export function parseGroups(raw: string): GroupsState {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return emptyGroups();
  }
  if (!isRecord(root)) return emptyGroups();

  const groups: Group[] = [];
  const seenIds = new Set<string>();
  const rawGroups = root['groups'];
  if (Array.isArray(rawGroups)) {
    for (const [i, g] of rawGroups.entries()) {
      if (!isRecord(g)) continue;
      const id = name(g['id']);
      const label = name(g['name']);
      if (id === undefined || label === undefined) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const order = typeof g['order'] === 'number' && Number.isFinite(g['order']) ? g['order'] : i;
      const color = name(g['color']);
      groups.push(color === undefined ? { id, name: label, order } : { id, name: label, order, color });
    }
  }
  groups.sort((a, b) => a.order - b.order);

  const ids = new Set(groups.map((g) => g.id));
  const assignments: Record<string, string> = {};
  const rawAssignments = root['assignments'];
  if (isRecord(rawAssignments)) {
    for (const [sessionId, groupId] of Object.entries(rawAssignments)) {
      if (typeof groupId === 'string' && ids.has(groupId)) assignments[sessionId] = groupId;
    }
  }

  // Un ordre est une liste d'identifiants de sessions, rien d'autre : une entrée
  // mal formée est ignorée plutôt que de faire tomber toute la lecture. Les
  // identifiants qui ne correspondent à rien ne sont PAS filtrés ici — une
  // session peut être momentanément absente (fenêtre qui n'a pas encore lu le
  // spool) et retrouver sa place ensuite. Le nettoyage est le travail de
  // `pruneAssignments`, qui sait ce qui vit vraiment.
  const sessionOrder: Record<string, readonly string[]> = {};
  const rawOrder = root['sessionOrder'];
  if (isRecord(rawOrder)) {
    for (const [groupId, ids] of Object.entries(rawOrder)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (clean.length > 0) sessionOrder[groupId] = clean;
    }
  }

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) if (!KNOWN.has(k)) unknown[k] = v;

  return { groups, assignments, sessionOrder, unknown };
}

export function serializeGroups(s: GroupsState): string {
  const body = { ...s.unknown, version: 1, groups: s.groups, assignments: s.assignments, sessionOrder: s.sessionOrder };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function createGroup(s: GroupsState, label: string, newId: () => string): GroupsState {
  const clean = name(label);
  if (clean === undefined) throw new Error('Un dossier ne peut pas avoir un nom vide.');
  return { ...s, groups: [...s.groups, { id: newId(), name: clean, order: s.groups.length }] };
}

export function renameGroup(s: GroupsState, id: string, label: string): GroupsState {
  const clean = name(label);
  if (clean === undefined) throw new Error('Un dossier ne peut pas avoir un nom vide.');
  return { ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) };
}

/**
 * `color === undefined` retire la couleur au lieu de l'ignorer : « aucune » est
 * un choix de l'utilisateur, pas une absence de choix. La propriété est alors
 * retirée de l'objet, pour qu'un dossier sans couleur ne laisse pas une clé
 * morte dans le fichier partagé.
 */
export function setGroupColor(s: GroupsState, id: string, color: string | undefined): GroupsState {
  return {
    ...s,
    groups: s.groups.map((g) => {
      if (g.id !== id) return g;
      const { color: _drop, ...rest } = g;
      return color === undefined ? rest : { ...rest, color };
    }),
  };
}

export function deleteGroup(s: GroupsState, id: string): GroupsState {
  const groups = s.groups.filter((g) => g.id !== id).map((g, i) => ({ ...g, order: i }));
  const assignments: Record<string, string> = {};
  for (const [sessionId, groupId] of Object.entries(s.assignments)) {
    if (groupId !== id) assignments[sessionId] = groupId;
  }
  // L'ordre du dossier disparaît avec lui : ses sessions retournent à « Sans
  // dossier », où elles reprennent le tri par défaut. Le garder ferait
  // ressurgir un classement fantôme si un dossier réutilisait cet identifiant.
  const { [id]: _dropped, ...sessionOrder } = s.sessionOrder;
  return { ...s, groups, assignments, sessionOrder };
}

export function assign(s: GroupsState, sessionId: string, groupId: string): GroupsState {
  if (!s.groups.some((g) => g.id === groupId)) return s;
  return { ...s, assignments: { ...s.assignments, [sessionId]: groupId } };
}

export function unassign(s: GroupsState, sessionId: string): GroupsState {
  if (s.assignments[sessionId] === undefined) return s;
  const assignments = { ...s.assignments };
  delete assignments[sessionId];
  return { ...s, assignments };
}

export function groupIdOf(s: GroupsState, sessionId: string): string | undefined {
  return s.assignments[sessionId];
}

export function sessionOrderOf(s: GroupsState, groupId: string | undefined): readonly string[] {
  return s.sessionOrder[orderKey(groupId)] ?? [];
}

/**
 * Fige l'ordre d'un dossier. Une liste vide retire l'entrée plutôt que d'écrire
 * un tableau vide : « aucun ordre choisi » et « un ordre vide » doivent rester
 * le même état, sinon le fichier accumulerait des dossiers ordonnés à néant.
 */
export function setSessionOrder(s: GroupsState, groupId: string | undefined, ids: readonly string[]): GroupsState {
  const key = orderKey(groupId);
  const { [key]: _dropped, ...rest } = s.sessionOrder;
  return { ...s, sessionOrder: ids.length === 0 ? rest : { ...rest, [key]: [...ids] } };
}

/**
 * Où atterrissent les sessions déplacées dans une liste.
 *
 * `before` est la session devant laquelle déposer — celle qu'on survolait — et
 * `undefined` veut dire « à la fin ». Les déplacées sont d'abord retirées : sans
 * ça, descendre une session dans son propre dossier la placerait avant
 * elle-même et rien ne bougerait.
 *
 * Le point d'insertion se calcule dans la liste D'ORIGINE, puis se corrige du
 * nombre de déplacées qui la précédaient. Le chercher dans la liste amputée
 * aurait un angle mort : quand on dépose une session sur ELLE-MÊME, elle ne
 * s'y trouve plus, et elle serait renvoyée à la fin — un geste sans intention
 * deviendrait un déplacement.
 */
export function reorder(
  current: readonly string[],
  moved: readonly string[],
  before: string | undefined,
): string[] {
  const movedSet = new Set(moved);
  const rest = current.filter((id) => !movedSet.has(id));
  if (before === undefined) return [...rest, ...moved];
  const target = current.indexOf(before);
  // Cible inconnue de ce dossier : à la fin, plutôt que de deviner.
  if (target === -1) return [...rest, ...moved];
  const removedBefore = current.slice(0, target).filter((id) => movedSet.has(id)).length;
  const at = target - removedBefore;
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

export function pruneAssignments(s: GroupsState, live: ReadonlySet<string>): GroupsState {
  const kept = Object.entries(s.assignments).filter(([sessionId]) => live.has(sessionId));
  const orderEntries = Object.entries(s.sessionOrder)
    .map(([key, ids]) => [key, ids.filter((id) => live.has(id))] as const)
    .filter(([, ids]) => ids.length > 0);
  const assignmentsUnchanged = kept.length === Object.keys(s.assignments).length;
  const orderUnchanged =
    orderEntries.length === Object.keys(s.sessionOrder).length &&
    orderEntries.every(([key, ids]) => ids.length === (s.sessionOrder[key]?.length ?? -1));
  // Même identité renvoyée quand il n'y a rien à retirer : l'appelant s'en sert
  // pour éviter une écriture inutile (groups/purge.ts).
  if (assignmentsUnchanged && orderUnchanged) return s;
  return { ...s, assignments: Object.fromEntries(kept), sessionOrder: Object.fromEntries(orderEntries) };
}
