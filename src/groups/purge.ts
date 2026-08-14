import type { SpoolDirs } from '../paths';
import { readSessions } from '../spool/persist';
import { pruneAssignments } from './model';
import { readGroups, updateGroups } from './store';

async function liveSessionIds(dirs: SpoolDirs): Promise<Set<string>> {
  return new Set((await readSessions(dirs)).keys());
}

/**
 * Retire du fichier de classement les affectations des sessions que le drain vient de purger.
 * Extraite du point d'appel (extension.ts) pour rester testable à la frontière de composition,
 * pas seulement au niveau de la primitive pure (`pruneAssignments`) qu'elle appelle — même
 * précédent qu'`acknowledgeVisibleSessions` (src/focus/acknowledge.ts) pour `onVisible`.
 *
 * Deux garde-fous contre une écriture à chaque tick de drain (la plupart ne purgent rien) :
 * 1. `purged` vide : aucune lecture, aucune écriture — c'est le cas de la quasi-totalité des
 *    passages.
 * 2. `purged` non vide mais aucune des sessions purgées n'était classée dans un dossier :
 *    `pruneAssignments` rend alors le même objet (garantie d'identité, voir model.ts) et on
 *    s'en sert ici pour ne pas appeler `updateGroups`, qui écrirait sinon inconditionnellement
 *    (il ne compare jamais son résultat à l'état courant avant de renommer). Cette lecture-là
 *    n'est qu'une optimisation : elle décide seulement si l'appel vaut la peine, jamais ce qui
 *    doit être retiré — voir la règle ci-dessous.
 *
 * Règle générale (tour de correction 1, Critique 1) : rien de ce qui sert à décider ne doit
 * être lu avant l'état sur lequel on décide. `live` — la liste des sessions vivantes — est donc
 * recalculé à l'intérieur même de la transformation passée à `updateGroups`, au même moment que
 * l'état `s` qu'elle reçoit, jamais avant. Une première version capturait `live` une seule fois,
 * tout en haut de cette fonction, et la réutilisait telle quelle dans la transformation :
 * `updateGroups` relit l'état à l'intérieur, donc son `before` pouvait déjà contenir une
 * affectation toute fraîche vers une session apparue entre-temps — mais ce `live` figé
 * l'ignorait, `pruneAssignments` la retirait à tort, et `mergeAssignments` interprétait ce
 * retrait comme une suppression volontaire : une session bien vivante perdait son classement en
 * silence. Troisième occurrence de cette même famille de défaut dans ce projet (drain() sur un
 * instantané de session, purgeStaleSessions sur un instantané de la carte) : toujours à une
 * frontière de composition, jamais dans une primitive pure ; toujours une donnée lue tôt qui
 * sert à décider du sort d'une donnée lue tard.
 */
export async function pruneAssignmentsAfterPurge(
  dirs: SpoolDirs,
  file: string,
  purged: readonly string[],
): Promise<void> {
  if (purged.length === 0) return;

  const before = await readGroups(file);
  if (pruneAssignments(before, await liveSessionIds(dirs)) === before) return;

  await updateGroups(file, async (s) => pruneAssignments(s, await liveSessionIds(dirs)));
}
