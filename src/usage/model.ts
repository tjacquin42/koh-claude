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
function windowOf(v: unknown): UsageWindow | undefined {
  if (!isRecord(v)) return undefined;
  const percent = v['used_percentage'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return undefined;
  }
  const resets = v['resets_at'];
  // Une échéance absente n'invalide pas le pourcentage : on affiche ce qu'on a.
  const resetsAt = typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? resets : undefined;
  return { percent, resetsAt };
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
