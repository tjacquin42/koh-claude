/**
 * Ce que Claude Code passe à la statusline, et que le pont dépose tel quel.
 *
 * La forme observée :
 *   {"rate_limits":{"five_hour":{"used_percentage":78,"resets_at":1786297800},
 *                   "seven_day":{"used_percentage":32,"resets_at":1786712400}}}
 *
 * `resets_at` est en SECONDES depuis l'époque, pas en millisecondes : c'est la
 * convention d'Unix, pas celle de JavaScript, et les confondre placerait la
 * réinitialisation en 1970.
 */
export interface UsageWindow {
  percent: number;
  resetsAt: number | undefined;
}

export interface Usage {
  fiveHour: UsageWindow | undefined;
  sevenDay: UsageWindow | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Un pourcentage doit être un nombre fini entre 0 et 100. Hors de ces bornes,
 * la fenêtre est ignorée plutôt qu'affichée : mieux vaut ne rien montrer qu'une
 * jauge à -3 % ou à 4000 %, qui ferait douter de tout le reste.
 */
/**
 * L'échéance arrive sous deux formes selon la source : un entier de secondes
 * Unix (statusline) ou une date ISO 8601 (API). Les deux sont ramenées à des
 * SECONDES, jamais à des millisecondes — c'est l'unité que porte `UsageWindow`,
 * et les confondre placerait la réinitialisation en 1970.
 */
function resetsAtOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : undefined;
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

function windowOf(v: unknown): UsageWindow | undefined {
  if (!isRecord(v)) return undefined;
  // `used_percentage` (statusline) et `utilization` (API) désignent la même
  // chose sous deux noms. Un seul lecteur pour les deux, plutôt que deux
  // lecteurs qui divergeraient.
  const raw = v['used_percentage'] ?? v['utilization'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) return undefined;
  // Une échéance absente n'invalide pas le pourcentage : on affiche ce qu'on a.
  return { percent: raw, resetsAt: resetsAtOf(v['resets_at']) };
}

/**
 * `undefined` quand l'instantané ne porte aucune fenêtre exploitable — la vue
 * n'affiche alors rien du tout, plutôt qu'une ligne vide qui laisserait croire
 * à une consommation nulle.
 */
export function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  // Deux sources, deux emboîtements : la statusline enveloppe ses fenêtres dans
  // `rate_limits`, le cache de Vibe Island les porte à la racine. Les champs
  // eux-mêmes sont identiques, donc une seule lecture suffit — dès lors qu'on
  // regarde au bon niveau.
  const nested = raw['rate_limits'];
  const limits = isRecord(nested) ? nested : raw;
  const fiveHour = windowOf(limits['five_hour']);
  const sevenDay = windowOf(limits['seven_day']);
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  return { fiveHour, sevenDay };
}
