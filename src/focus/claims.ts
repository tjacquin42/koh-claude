import { sep } from 'node:path';

/** Le séparateur évite qu'un projet voisin au préfixe commun soit revendiqué. */
export function claims(folders: readonly string[], cwd: string): boolean {
  return folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(sep) ? f : f + sep));
}
