import { assign, createGroup, deleteGroup, renameGroup, unassign } from './model';
import type { GroupsState } from './model';
import { updateGroups } from './store';

/**
 * Crée un dossier depuis le nom saisi par l'utilisateur. `label === undefined`
 * signale une boîte de saisie annulée (Échap) : rien à faire, rien à écrire.
 * Un nom vide ou fait seulement de blancs n'est PAS ce même cas — l'utilisateur
 * a validé une saisie vide — et `createGroup` (groups/model.ts) lève dans ce
 * cas, volontairement. C'est au point d'appel (`runGroupAction`, plus bas) de
 * transformer cette levée en message affiché, jamais en trace d'appel non
 * gérée : voir sa documentation.
 */
export async function createGroupCommand(
  groupsFilePath: string,
  label: string | undefined,
  newId: () => string,
): Promise<GroupsState | undefined> {
  if (label === undefined) return undefined;
  return updateGroups(groupsFilePath, (s) => createGroup(s, label, newId));
}

/** Même contrat que `createGroupCommand`, pour un renommage. */
export async function renameGroupCommand(
  groupsFilePath: string,
  id: string,
  label: string | undefined,
): Promise<GroupsState | undefined> {
  if (label === undefined) return undefined;
  return updateGroups(groupsFilePath, (s) => renameGroup(s, id, label));
}

/**
 * Supprime un dossier. Aucune saisie à annuler ici (pas de boîte de dialogue
 * pour ce geste) : appelée seulement quand un identifiant de dossier valide a
 * déjà été résolu au point d'appel (voir `groupIdOfNode`, ui/tree.ts).
 */
export async function deleteGroupCommand(groupsFilePath: string, id: string): Promise<GroupsState> {
  return updateGroups(groupsFilePath, (s) => deleteGroup(s, id));
}

/**
 * Le vrai câblage du glisser-déposer (voir `SessionsTree.onDrop`, injecté au
 * constructeur) : affecte chaque session déposée au dossier ciblé, ou la
 * retire de tout classement quand la cible est « Sans dossier »
 * (`groupId === undefined`). Un seul appel à `updateGroups` pour tout le lot
 * déposé — jamais un par session — pour qu'un dépôt multiple atterrisse dans
 * une unique écriture, sans jamais s'entrelacer avec une autre fenêtre entre
 * deux identifiants du même dépôt.
 */
export async function applyDrop(
  groupsFilePath: string,
  sessionIds: readonly string[],
  groupId: string | undefined,
): Promise<GroupsState> {
  return updateGroups(groupsFilePath, (s) =>
    sessionIds.reduce((acc, id) => (groupId === undefined ? unassign(acc, id) : assign(acc, id, groupId)), s),
  );
}

/**
 * Exécute une commande de dossier et transforme tout ce qu'elle lève en
 * message affiché par `onError`, jamais en trace d'appel non gérée — c'est le
 * seul endroit qui sait qu'un nom vide (entre autres) doit finir en message
 * plutôt qu'en plantage : aucune des trois commandes ci-dessus ne connaît
 * `vscode.window.showErrorMessage`, seul le point de câblage (extension.ts)
 * le branche sur `onError`.
 */
export async function runGroupAction(
  action: () => Promise<unknown>,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}
