import type { Session, Status } from '../events/types';

/**
 * L'événement qui mérite un son, et son réglage.
 *
 * Pas « tout changement de statut » : une session passe d'elle-même de
 * `running` à `idle` puis à `stale` sans que rien ne se soit produit pour
 * l'utilisateur, et un carillon à chaque bascule deviendrait un bruit de fond
 * qu'on apprend à ignorer — donc un signal mort. Ne sonnent que les deux
 * transitions qui appellent une action.
 */
export type ChimeEvent = 'waiting' | 'done';

const EVENT_OF: Partial<Record<Status, ChimeEvent>> = {
  waiting: 'waiting',
  done_unseen: 'done',
};

export function statusesOf(sessions: ReadonlyMap<string, Session>): Map<string, Status> {
  return new Map([...sessions].map(([id, s]) => [id, s.status]));
}

/** Ce qui a basculé, et laquelle : le son se résout ensuite sur cette session. */
export interface Chime {
  event: ChimeEvent;
  sessionId: string;
}

/**
 * Quelle bascule mérite un son, s'il y en a une.
 *
 * `before === undefined` est le PREMIER rendu : tout y ressemble à une
 * transition, et sonner ferait carillonner l'éditeur à chaque ouverture de
 * fenêtre pour des sessions parfois vieilles de plusieurs heures. Le premier
 * rendu ne fait que poser la référence.
 *
 * Une session inconnue de `before` mais présente ensuite ne sonne pas non plus :
 * elle vient d'apparaître dans le spool, on ne sait pas d'où elle vient.
 *
 * Une seule bascule retenue par tour, même si plusieurs surviennent : deux
 * carillons simultanés ne s'entendent pas mieux qu'un. « T'attend » l'emporte
 * sur « terminé » — c'est celui qui demande quelque chose.
 */
export function chimeFor(
  before: ReadonlyMap<string, Status> | undefined,
  after: ReadonlyMap<string, Status>,
): Chime | undefined {
  if (before === undefined) return undefined;
  let found: Chime | undefined;
  for (const [sessionId, status] of after) {
    const was = before.get(sessionId);
    if (was === undefined || was === status) continue;
    const event = EVENT_OF[status];
    if (event === 'waiting') return { event, sessionId };
    if (event !== undefined) found ??= { event, sessionId };
  }
  return found;
}
