import { branchOf, originOf, projectOf } from '../events/origin';
import { HOOK_EVENTS, type EventName, type HookEvent, type Session, type SpoolEvent } from '../events/types';

/** Seul un événement de hook Claude Code décrit une session qui existe : un de
 * nos événements locaux (`Ack`) réagit à une session déjà vue, il ne doit
 * jamais en faire naître une nouvelle de toutes pièces. */
function isHookEvent(event: EventName): event is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(event);
}

function create(ev: SpoolEvent): Session {
  const session: Session = {
    id: ev.sessionId,
    cwd: ev.cwd,
    project: projectOf(ev.cwd),
    origin: originOf(ev.entrypoint, ev.termProgram),
    status: 'idle',
    toolCount: 0,
    lastEventAt: ev.at,
  };
  const branch = branchOf(ev.cwd);
  if (branch !== undefined) session.branch = branch;
  return session;
}

/**
 * Fonction pure. Deux fenêtres VSCode qui rejouent les mêmes événements
 * aboutissent au même état — c'est ce qui rend la convergence possible sans verrou.
 *
 * Retourne `undefined` quand la session doit disparaître.
 */
export function reduce(prev: Session | undefined, ev: SpoolEvent): Session | undefined {
  if (ev.event === 'SessionEnd') return undefined;
  if (prev === undefined && !isHookEvent(ev.event)) return undefined;

  const base = prev ?? create(ev);

  // Le spool n'ordonne pas : un événement peut arriver après un plus récent.
  // On accepte ses effets cumulatifs, jamais ses transitions de statut.
  const late = ev.at < base.lastEventAt;
  const next: Session = { ...base, lastEventAt: Math.max(base.lastEventAt, ev.at) };
  if (ev.transcriptPath !== undefined) next.transcriptPath = ev.transcriptPath;

  switch (ev.event) {
    case 'SessionStart':
      next.startedAt = base.startedAt ?? ev.at;
      break;
    case 'UserPromptSubmit':
      if (!late) {
        next.status = 'running';
        delete next.pendingPermission;
      }
      break;
    case 'PreToolUse':
      if (!late) {
        next.status = 'running';
        next.inFlightSince = ev.at;
        next.currentAction = { tool: ev.toolName ?? 'outil', target: ev.toolTarget };
        delete next.pendingPermission;
      }
      break;
    case 'PostToolUse':
      next.toolCount = base.toolCount + 1;
      if (!late) {
        delete next.inFlightSince;
        delete next.currentAction;
      }
      break;
    case 'PermissionRequest':
      if (!late) {
        next.status = 'waiting';
        next.pendingPermission = {
          tool: ev.toolName ?? 'outil',
          summary: ev.toolTarget ?? ev.message ?? '',
        };
      }
      break;
    case 'Notification':
      if (!late) next.status = 'waiting';
      break;
    case 'Stop':
      if (!late) {
        next.status = 'done_unseen';
        delete next.inFlightSince;
        delete next.currentAction;
      }
      break;
    case 'Ack':
      if (!late && base.status === 'done_unseen') next.status = 'idle';
      break;
    default: {
      // Garde d'exhaustivité : un futur membre d'`EventName` non traité ici
      // devient une erreur de compilation plutôt qu'un trou silencieux.
      const exhaustive: never = ev.event;
      throw new Error(`événement non géré par le réducteur : ${String(exhaustive)}`);
    }
  }

  return next;
}

export function reduceAll(events: readonly SpoolEvent[]): Map<string, Session> {
  const out = new Map<string, Session>();
  for (const ev of events) {
    const next = reduce(out.get(ev.sessionId), ev);
    if (next === undefined) out.delete(ev.sessionId);
    else out.set(ev.sessionId, next);
  }
  return out;
}
