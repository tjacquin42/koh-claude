import { sep } from 'node:path';

/**
 * Comparaison insensible à la casse : macOS (HFS+/APFS par défaut) préserve la
 * casse sans la distinguer, donc un `cwd` de hook capturé avec une casse
 * différente de celle du dossier ouvert dans la fenêtre reste le même projet.
 * Le séparateur évite qu'un projet voisin au préfixe commun soit revendiqué.
 */
export function claims(folders: readonly string[], cwd: string): boolean {
  const target = cwd.toLowerCase();
  return folders.some((f) => {
    const folder = f.toLowerCase();
    return target === folder || target.startsWith(folder.endsWith(sep) ? folder : folder + sep);
  });
}
