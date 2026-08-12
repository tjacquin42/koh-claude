import { sep } from 'node:path';
import type { Session } from '../events/types';

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

/**
 * Sessions « terminé non lu » que ces dossiers de workspace revendiquent :
 * exactement ce que la spec (§5) acquitte quand la vue devient visible dans
 * une fenêtre — « la fenêtre qui la revendique », jamais toutes les sessions
 * de tous les projets. Fonction pure, extraite pour la même raison que
 * `claims()` : rester testable sans `vscode`.
 */
export function sessionsToAcknowledge(sessions: Iterable<Session>, folders: readonly string[]): Session[] {
  const out: Session[] = [];
  for (const s of sessions) {
    if (s.status === 'done_unseen' && claims(folders, s.cwd)) out.push(s);
  }
  return out;
}
