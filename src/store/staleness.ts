import type { Session } from '../events/types';

/** Silence toléré pour une session en cours sans outil en vol. */
export const STALE_SILENT_MS = 5 * 60_000;

/**
 * Plafond quand un outil est en vol. Un `pnpm -r test` de dix minutes n'émet
 * aucun événement entre son PreToolUse et son PostToolUse : sans cette exception,
 * la session la plus active serait marquée morte. Le plafond rattrape le cas du
 * processus tué en plein outil, qui n'enverra jamais son PostToolUse.
 */
export const STALE_IN_FLIGHT_MS = 30 * 60_000;

/**
 * Au-delà de ce délai sans le moindre événement, une session est purgée
 * (`sessions/<id>.json` supprimé) plutôt que simplement marquée périmée :
 * spec §5, ligne 206. Sans purge, une session morte sans `SessionEnd`
 * (process tué, machine éteinte) reste affichée indéfiniment.
 */
export const SESSION_PURGE_MS = 24 * 60 * 60_000;

export function withStaleness(s: Session, now: number): Session {
  if (s.status !== 'running') return s;
  const limit = s.inFlightSince === undefined ? STALE_SILENT_MS : STALE_IN_FLIGHT_MS;
  return now - s.lastEventAt > limit ? { ...s, status: 'stale' } : s;
}
