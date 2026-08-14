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
  /** Champs du fichier que nous ne connaissons pas : préservés tels quels à l'écriture. */
  unknown: Readonly<Record<string, unknown>>;
}

const KNOWN = new Set(['version', 'groups', 'assignments']);

export function emptyGroups(): GroupsState {
  return { groups: [], assignments: {}, unknown: {} };
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

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root)) if (!KNOWN.has(k)) unknown[k] = v;

  return { groups, assignments, unknown };
}

export function serializeGroups(s: GroupsState): string {
  return `${JSON.stringify({ ...s.unknown, version: 1, groups: s.groups, assignments: s.assignments }, null, 2)}\n`;
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
  return { ...s, groups, assignments };
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

/**
 * Retire les affectations des sessions qui n'existent plus. Sans ça le fichier
 * accumulerait une entrée par session vue depuis l'installation.
 */
export function pruneAssignments(s: GroupsState, live: ReadonlySet<string>): GroupsState {
  const kept = Object.entries(s.assignments).filter(([sessionId]) => live.has(sessionId));
  if (kept.length === Object.keys(s.assignments).length) return s;
  return { ...s, assignments: Object.fromEntries(kept) };
}
