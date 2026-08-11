import { basename } from 'node:path';
import type { Session, Status } from '../events/types';

const STATUS_FR: Record<Status, string> = {
  running: 'en cours',
  waiting: "t'attend",
  done_unseen: 'terminé',
  idle: "à l'arrêt",
  stale: 'périmée',
};

export function statusLabel(status: Status): string {
  return STATUS_FR[status];
}

export function formatAge(ms: number): string {
  // Troncature et non arrondi : un âge écoulé se lit vers le bas. Avec un arrondi,
  // 90 s afficherait « 2 min », et 59,9 s afficherait « 60 s » au lieu de « 1 min ».
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** La branche identifie mieux une session que le projet, déjà porté par le groupe. */
export function sessionLabel(s: Session): string {
  return s.branch ?? s.project;
}

export function sessionDescription(s: Session, now: number): string {
  if (s.pendingPermission !== undefined) {
    return `permission : ${s.pendingPermission.summary || s.pendingPermission.tool}`;
  }
  if (s.currentAction !== undefined) {
    const target = s.currentAction.target;
    return target === undefined
      ? s.currentAction.tool
      : `${s.currentAction.tool} ${basename(target)}`;
  }
  return `${statusLabel(s.status)} · ${formatAge(now - s.lastEventAt)}`;
}

export function sessionTooltip(s: Session, now: number): string {
  const lines = [
    `${s.project}${s.branch === undefined ? '' : ` / ${s.branch}`}`,
    `${statusLabel(s.status)} · ${formatAge(now - s.lastEventAt)}`,
    `origine : ${s.origin}`,
    `${s.toolCount} outil${s.toolCount > 1 ? 's' : ''}`,
  ];
  if (s.tokens !== undefined) {
    lines.push(`${formatTokens(s.tokens.input)} entrée / ${formatTokens(s.tokens.output)} sortie`);
  }
  lines.push(s.cwd);
  return lines.join('\n');
}
