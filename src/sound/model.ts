import type { Session, Status } from '../events/types';

/**
 * Les statuts qui méritent un son.
 *
 * Pas « tout changement de statut » : une session passe d'elle-même de
 * `running` à `idle` puis à `stale` sans que rien ne se soit produit pour
 * l'utilisateur, et un carillon à chaque bascule deviendrait un bruit de fond
 * qu'on apprend à ignorer — donc un signal mort. Ne sonnent que les deux
 * transitions qui appellent une action : une session qui t'attend, et une
 * session qui vient de finir.
 */
const CHIMING: ReadonlySet<Status> = new Set<Status>(['waiting', 'done_unseen']);

export function statusesOf(sessions: ReadonlyMap<string, Session>): Map<string, Status> {
  return new Map([...sessions].map(([id, s]) => [id, s.status]));
}

/**
 * Faut-il sonner ?
 *
 * `before === undefined` est le PREMIER rendu : tout y ressemble à une
 * transition, et sonner ferait carillonner l'éditeur à chaque ouverture de
 * fenêtre pour des sessions parfois vieilles de plusieurs heures. Le premier
 * rendu ne fait que poser la référence.
 *
 * Une session inconnue de `before` mais présente ensuite ne sonne pas non plus :
 * elle vient d'apparaître dans le spool, on ne sait pas d'où elle vient.
 */
export function shouldChime(
  before: ReadonlyMap<string, Status> | undefined,
  after: ReadonlyMap<string, Status>,
): boolean {
  if (before === undefined) return false;
  for (const [id, status] of after) {
    const was = before.get(id);
    if (was === undefined || was === status) continue;
    if (CHIMING.has(status)) return true;
  }
  return false;
}
