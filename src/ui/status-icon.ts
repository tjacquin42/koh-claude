import { join } from 'node:path';
import type { Status } from '../events/types';

/** Sous-dossier de `resources/` où scripts/make-status-icons.cjs dépose les pastilles. */
export const STATUS_ICON_DIR = 'status';

/**
 * Le chemin des deux pastilles d'un statut — une par famille de thème.
 *
 * Pourquoi une IMAGE, alors qu'un `ThemeIcon` coloré s'adapterait à tous les
 * thèmes, y compris tiers ? Parce que VSCode l'éteint dès que la ligne est
 * sélectionnée. La règle vit dans son propre CSS :
 *
 *   .customview-tree … .monaco-list-row.selected … .custom-view-tree-node-item-icon.codicon
 *     { color: currentColor !important }
 *
 * Le `!important` écrase la `ThemeColor` posée par l'extension : la pastille
 * prend la couleur du texte de la ligne, grise quand la vue n'a pas le focus —
 * et cliquer une session donne justement le focus à l'éditeur. Le statut
 * disparaissait donc exactement sur la ligne qu'on venait de choisir. Aucune
 * API ne permet de passer outre : le sélecteur ne vise que `.codicon`, et une
 * icône-image n'en est pas une.
 *
 * Le prix est assumé : les couleurs sont figées aux valeurs par défaut de
 * VSCode (charts.* en clair et en sombre) au lieu de suivre un thème tiers.
 * Une pastille lisible mais d'un bleu un peu différent vaut mieux qu'une
 * pastille au bon bleu qu'on ne voit plus quand on en a besoin.
 */
export function statusIconPath(extensionPath: string, status: Status): { light: string; dark: string } {
  const file = (theme: 'light' | 'dark'): string =>
    join(extensionPath, 'resources', STATUS_ICON_DIR, `${status.replace('_', '-')}-${theme}.svg`);
  return { light: file('light'), dark: file('dark') };
}
