import type { SpoolDirs } from '../paths';
import { readSessions } from '../spool/persist';
import { pruneAssignments } from './model';
import { readGroups, updateGroups } from './store';

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
 *    (il ne compare jamais son résultat à l'état courant avant de renommer).
 *
 * Cette vérification préalable lit l'état une fois pour décider, mais ne s'en sert jamais pour
 * fusionner : si `updateGroups` est finalement appelé, il relit et fusionne lui-même contre
 * l'état le plus frais, comme toujours. Une session ré-affectée par une autre fenêtre dans
 * l'instant qui sépare cette lecture de décision de l'appel à `updateGroups` (fenêtre étroite,
 * jamais observée en pratique) survivrait à ce passage-ci ; rien ne la reclasse ensuite,
 * puisqu'une session déjà purgée ne réapparaît plus dans un futur `purged`.
 */
export async function pruneAssignmentsAfterPurge(
  dirs: SpoolDirs,
  file: string,
  purged: readonly string[],
): Promise<void> {
  if (purged.length === 0) return;

  const live = new Set((await readSessions(dirs)).keys());
  const current = await readGroups(file);
  if (pruneAssignments(current, live) === current) return;

  await updateGroups(file, (s) => pruneAssignments(s, live));
}
