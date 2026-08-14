import * as vscode from 'vscode';

/**
 * La palette proposée pour les dossiers.
 *
 * `id` est ce qui s'écrit dans groups.json : neutre, stable, indépendant de la
 * langue et du thème. `theme` est une couleur enregistrée par VSCode — jamais
 * un code hexadécimal — pour que les dossiers restent lisibles en clair comme
 * en sombre, et sous les thèmes tiers. `label` n'existe que pour la liste de
 * choix.
 *
 * Les mêmes `charts.*` servent déjà aux pastilles de statut (ui/tree.ts) : une
 * seule famille de couleurs dans la vue, pas deux qui jureraient.
 */
export interface GroupColor {
  id: string;
  /** Shown in the picker, so translated. Never written to disk — `id` is. */
  label: string;
  theme: string;
}

export const GROUP_COLORS: readonly GroupColor[] = [
  { id: 'blue', label: vscode.l10n.t('Blue'), theme: 'charts.blue' },
  { id: 'green', label: vscode.l10n.t('Green'), theme: 'charts.green' },
  { id: 'yellow', label: vscode.l10n.t('Yellow'), theme: 'charts.yellow' },
  { id: 'orange', label: vscode.l10n.t('Orange'), theme: 'charts.orange' },
  { id: 'red', label: vscode.l10n.t('Red'), theme: 'charts.red' },
  { id: 'purple', label: vscode.l10n.t('Purple'), theme: 'charts.purple' },
];

/**
 * Une couleur qu'on ne connaît pas vaut « aucune couleur », jamais une erreur :
 * le fichier est partagé, et une version plus récente de l'extension installée
 * sur l'autre éditeur peut très bien y avoir écrit une couleur que celle-ci
 * n'a pas encore. Le dossier s'affiche alors sans couleur — et la valeur
 * inconnue survit dans le fichier, elle n'est pas réécrite.
 */
export function themeColorOf(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return GROUP_COLORS.find((c) => c.id === color)?.theme;
}

/** The picker entry that removes the colour. */
export const NO_COLOR_LABEL = vscode.l10n.t('None');

/**
 * Ce que veut dire ce que l'utilisateur a choisi dans la liste des couleurs.
 *
 * Trois cas, et il est essentiel qu'ils restent trois : fermer la liste
 * (`undefined`) n'est PAS choisir « Aucune ». S'ils se confondaient, annuler
 * effacerait la couleur du dossier — le geste le plus anodin deviendrait
 * destructeur.
 *
 * Un libellé qu'on ne reconnaît pas vaut annulation, jamais effacement : c'est
 * le cas qui ne devrait pas arriver, puisque la liste est bâtie depuis cette
 * palette. Il est traité quand même, parce qu'un jour la liste et la palette
 * pourraient cesser d'être bâties ensemble, et que ce jour-là le pire résultat
 * possible serait d'effacer en silence.
 */
export type ColorChoice = { kind: 'cancel' } | { kind: 'set'; color: string | undefined };

export function colorChoice(pick: string | undefined): ColorChoice {
  if (pick === undefined) return { kind: 'cancel' };
  if (pick === NO_COLOR_LABEL) return { kind: 'set', color: undefined };
  const found = GROUP_COLORS.find((c) => c.label === pick);
  return found === undefined ? { kind: 'cancel' } : { kind: 'set', color: found.id };
}
