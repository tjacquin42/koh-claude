import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { statusFile, usageFile } from '../paths';
import { parseUsage, type Usage } from './model';
import { fetchUsage, readAccessToken } from './oauth';

export type UsageSource = 'api' | 'statusline';

export interface UsageReading {
  usage: Usage;
  source: UsageSource;
  /** Date de dernière écriture du fichier, pour dire l'âge de la mesure. */
  at: number;
}

/**
 * Au-delà, on redemande à l'API. En deçà, le cache partagé suffit : plusieurs
 * fenêtres rendent leur arbre toutes les deux secondes, et chacune interrogeant
 * l'API pour afficher le même chiffre serait absurde autant qu'impoli.
 */
export const REFRESH_AFTER_MS = 5 * 60_000;

async function reading(path: string, source: UsageSource): Promise<UsageReading | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const usage = parseUsage(JSON.parse(raw) as unknown);
    return usage === undefined ? undefined : { usage, source, at: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Dernière TENTATIVE, par racine d'état et pour ce processus.
 *
 * Compter les tentatives et non les succès est tout l'intérêt : sans ça, une
 * API injoignable ou un trousseau refusé ne produisent aucun fichier, donc rien
 * qui date — et le rendu, qui tourne toutes les deux secondes, relancerait un
 * `security` et une requête HTTPS à chaque tour. Un échec doit coûter aussi peu
 * qu'un succès.
 */
const lastAttempt = new Map<string, number>();

/** Injectable pour éprouver le rythme sans trousseau ni réseau. */
export interface UsageDeps {
  readToken: () => Promise<string | undefined>;
  fetch: (token: string) => Promise<unknown>;
  now: () => number;
}

const REAL_DEPS: UsageDeps = { readToken: readAccessToken, fetch: fetchUsage, now: () => Date.now() };

/** Remet le compteur de tentatives à zéro (tests). */
export function forgetAttempts(): void {
  lastAttempt.clear();
}

/**
 * Interroge l'API et met le résultat en cache. `force` court-circuite le délai :
 * c'est ce que fait le bouton de rafraîchissement, dont l'intérêt serait nul
 * s'il devait attendre l'échéance comme un rendu ordinaire.
 *
 * N'échoue jamais bruyamment : trousseau refusé, hors ligne, point d'entrée
 * changé — tout cela vaut « pas de nouvelle mesure », et l'ancienne reste
 * affichée avec son âge.
 */
export async function refreshFromApi(
  home: string,
  force: boolean,
  deps: UsageDeps = REAL_DEPS,
): Promise<UsageReading | undefined> {
  const cached = await reading(usageFile(home), 'api');
  const now = deps.now();
  if (!force) {
    if (now - (lastAttempt.get(home) ?? 0) < REFRESH_AFTER_MS) return cached;
    // Une autre fenêtre vient peut-être de le faire pour nous : le cache est
    // partagé, et deux fenêtres qui interrogent l'API pour afficher le même
    // chiffre seraient une dépense pour rien.
    if (cached !== undefined && now - cached.at < REFRESH_AFTER_MS) return cached;
  }
  lastAttempt.set(home, now);

  const token = await deps.readToken();
  if (token === undefined) return cached;
  const raw = await deps.fetch(token);
  if (parseUsage(raw) === undefined) return cached;

  // Écriture atomique : une autre fenêtre peut lire pendant qu'on écrit — même
  // règle que le spool et le classement.
  const target = usageFile(home);
  const tmp = join(dirname(target), `.tmp-usage-${process.pid}`);
  try {
    await writeFile(tmp, JSON.stringify(raw), 'utf8');
    await rename(tmp, target);
  } catch {
    // Le relevé vaut d'être affiché même si on n'a pas su le garder.
  }
  return (await reading(target, 'api')) ?? cached;
}

/**
 * La plus FRAÎCHE des deux mesures locales, jamais la première trouvée.
 *
 * Un ordre de priorité fixe afficherait un chiffre périmé dès que la source
 * préférée se tait — et les deux se taisent tour à tour : la statusline ne se
 * déclenche pas dans une session hébergée par l'éditeur, et l'API peut être
 * hors d'atteinte.
 */
export async function readUsage(home: string): Promise<UsageReading | undefined> {
  const [api, line] = await Promise.all([
    reading(usageFile(home), 'api'),
    reading(statusFile(home), 'statusline'),
  ]);
  if (api === undefined) return line;
  if (line === undefined) return api;
  return line.at > api.at ? line : api;
}
