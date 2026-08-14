/**
 * Colorer le LIBELLÉ d'une ligne, et pas seulement son icône.
 *
 * VSCode n'offre aucune propriété de couleur sur un `TreeItem`. Le seul levier
 * est le `FileDecorationProvider` : on donne à la ligne un `resourceUri`, et le
 * fournisseur répond une couleur pour cette URI.
 *
 * La couleur voyage DANS l'URI plutôt que dans un état tenu à côté. Un
 * fournisseur qui garderait sa propre table devrait être resynchronisé à chaque
 * changement de couleur, et une table en retard d'un cran est exactement le
 * défaut qu'on a déjà payé trois fois ici. Une URI change quand la couleur
 * change ; VSCode redemande alors la décoration de lui-même.
 */
export const KOH_SCHEME = 'koh-vibe';

/** Ce qui distingue nos URI de toute autre : un schéma à nous, jamais `file`. */
export function decorationUriParts(
  kind: 'group' | 'session',
  id: string,
  theme: string,
): { scheme: string; authority: string; path: string; query: string } {
  return { scheme: KOH_SCHEME, authority: kind, path: `/${id}`, query: `c=${theme}` };
}

/**
 * La couleur portée par une URI, ou `undefined` si ce n'est pas une des nôtres.
 *
 * Ne renvoie une couleur que pour notre schéma : appelé pour CHAQUE ressource
 * que VSCode affiche, ce fournisseur ne doit jamais teinter un fichier de
 * l'utilisateur au motif que sa query ressemble à la nôtre.
 */
export function decorationColorOf(uri: { scheme: string; query: string }): string | undefined {
  if (uri.scheme !== KOH_SCHEME) return undefined;
  const value = new URLSearchParams(uri.query).get('c');
  return value !== null && value.length > 0 ? value : undefined;
}
