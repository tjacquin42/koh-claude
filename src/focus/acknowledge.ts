import type { SpoolDirs } from '../paths';
import type { Session } from '../events/types';
import { readSessions } from '../spool/persist';
import { appendLocalEvent } from '../spool/watcher';
import { sessionsToAcknowledge } from './claims';

/**
 * Acquitte (spec §5) les sessions « terminé non lu » que ces dossiers de
 * workspace revendiquent — l'action complète déclenchée quand la vue devient
 * visible dans une fenêtre. Extraite d'`onVisible` (extension.ts) pour rester
 * testable à la frontière de composition, pas seulement au niveau de la
 * primitive pure (`sessionsToAcknowledge`) qu'elle appelle : un relecteur a
 * prouvé par mutation qu'acquitter directement dans `extension.ts` sans
 * passer par cette primitive compilait et laissait tous les tests verts tant
 * que seule la primitive, jamais le point d'appel, était couverte.
 */
export async function acknowledgeVisibleSessions(dirs: SpoolDirs, folders: readonly string[]): Promise<void> {
  const sessions = await readSessions(dirs);
  for (const s of sessionsToAcknowledge(sessions.values(), folders)) {
    await appendLocalEvent(dirs, { event: 'Ack', sessionId: s.id, cwd: s.cwd });
  }
}

/**
 * Acquitte une session au clic (spec §5 : « clic sur la session »),
 * inconditionnellement — indépendamment de `claims()`, qui ne gouverne que
 * l'acquittement passif de `acknowledgeVisibleSessions` ci-dessus. Extraite
 * pour la même raison : le clic (kohClaude.focusSession) est le second
 * endroit où I6 a été perdu, et n'était protégé par aucun test avant cette
 * extraction. Un `Ack` sur une session inconnue ou déjà purgée ne la recrée
 * pas (I2, `reduce()` ignore un `Ack` sans session préalable) : aucune
 * vérification d'ordre n'est nécessaire ici.
 */
export async function acknowledgeClickedSession(
  dirs: SpoolDirs,
  s: Pick<Session, 'id' | 'cwd'>,
): Promise<void> {
  await appendLocalEvent(dirs, { event: 'Ack', sessionId: s.id, cwd: s.cwd });
}
