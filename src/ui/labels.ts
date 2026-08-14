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
  // Bascule à 999 500 et non à 1 000 000 : au-delà, l'arrondi au millier rendrait
  // « 1000k », qui casse le format compact au lieu de passer aux millions.
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Le titre complète la ligne, il ne la remplace pas : sans titre (les premières
 * secondes d'une session, avant que Claude n'en pose un), le repli sur
 * projet · branche reste la seule information qui dit où travaille la session.
 */
export function sessionLabel(s: Session): string {
  if (s.title !== undefined) return s.title;
  return s.branch === undefined ? s.project : `${s.project} · ${s.branch}`;
}

// Les blancs (dont les retours à la ligne d'une commande Bash multi-ligne)
// sont normalisés à la frontière (events/parse.ts, targetOf), pas ici : la
// valeur qui arrive dans `currentAction.target` est déjà propre, au même
// titre que `pendingPermission.summary`, qui partage la même source. Un
// second endroit qui répéterait cette normalisation serait le prochain piège
// (celui qu'on oublie de maintenir en même temps que l'autre).
export function sessionDescription(s: Session, now: number): string {
  if (s.pendingPermission !== undefined) {
    return `permission : ${s.pendingPermission.summary || s.pendingPermission.tool}`;
  }
  if (s.currentAction !== undefined) {
    const target = s.currentAction.target;
    return target === undefined ? s.currentAction.tool : `${s.currentAction.tool} ${basename(target)}`;
  }
  // Le statut n'est PAS répété ici en toutes lettres : la pastille de la ligne
  // (ui/tree.ts) le porte déjà, par sa forme et sa couleur. Le mot ne disparaît
  // pas pour autant — il reste dans l'infobulle et dans le libellé
  // d'accessibilité, les deux endroits où une icône ne suffit pas.
  const where = s.branch === undefined ? s.project : `${s.project} · ${s.branch}`;
  const age = formatAge(now - s.lastEventAt);
  return s.title === undefined ? age : `${where} · ${age}`;
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
