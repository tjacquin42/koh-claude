import { formatAge } from './labels';
import type { Usage, UsageWindow } from '../usage/model';
import type { UsageReading } from '../usage/reader';

/** Au-delà, la pastille change de couleur : l'usage devient une information à voir, pas à chercher. */
const WARN_PERCENT = 75;
const ALERT_PERCENT = 90;

function windowText(label: string, w: UsageWindow | undefined): string | undefined {
  return w === undefined ? undefined : `${label} ${Math.round(w.percent)} %`;
}

/** « 5 h 78 % · 7 j 32 % » — et seulement les fenêtres réellement mesurées. */
export function usageLabel(u: Usage): string {
  const parts = [windowText('5 h', u.fiveHour), windowText('7 j', u.sevenDay)].filter(
    (p): p is string => p !== undefined,
  );
  return parts.join(' · ');
}

/**
 * L'échéance est en secondes (convention Unix) et se compare donc à `now` en
 * millisecondes après conversion. Une échéance déjà passée n'affiche pas un
 * délai négatif : la fenêtre s'est réinitialisée, on le dit.
 */
function resetText(w: UsageWindow | undefined, now: number): string | undefined {
  if (w?.resetsAt === undefined) return undefined;
  const remaining = w.resetsAt * 1000 - now;
  return remaining <= 0 ? 'réinitialisée' : `dans ${formatAge(remaining)}`;
}

const SOURCE_FR: Record<UsageReading['source'], string> = {
  statusline: 'statusline Claude Code',
  'vibe-island': 'Vibe Island',
};

export function usageTooltip(r: UsageReading, now: number): string {
  const u = r.usage;
  const lines: string[] = [];
  if (u.fiveHour !== undefined) {
    lines.push(`5 heures : ${Math.round(u.fiveHour.percent)} %${suffix(resetText(u.fiveHour, now))}`);
  }
  if (u.sevenDay !== undefined) {
    lines.push(`7 jours : ${Math.round(u.sevenDay.percent)} %${suffix(resetText(u.sevenDay, now))}`);
  }
  // La provenance et l'âge sont dits, pas devinés : les deux sources se taisent
  // tour à tour, et un pourcentage sans date laisserait croire qu'il est frais.
  lines.push(`Source : ${SOURCE_FR[r.source]}, il y a ${formatAge(Math.max(0, now - r.at))}`);
  return lines.join('\n');
}

function suffix(text: string | undefined): string {
  return text === undefined ? '' : ` — ${text}`;
}

/**
 * La couleur suit la fenêtre la plus consommée, jamais leur moyenne : c'est
 * celle qui est près de la limite qui doit se voir, même si l'autre est basse.
 */
export function usageColor(u: Usage): string | undefined {
  const highest = Math.max(u.fiveHour?.percent ?? 0, u.sevenDay?.percent ?? 0);
  if (highest >= ALERT_PERCENT) return 'charts.red';
  if (highest >= WARN_PERCENT) return 'charts.yellow';
  return undefined;
}
