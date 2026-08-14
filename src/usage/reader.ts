import { readFile, stat } from 'node:fs/promises';
import { statusFile, vibeIslandUsageFile } from '../paths';
import { parseUsage, type Usage } from './model';

export type UsageSource = 'statusline' | 'vibe-island';

export interface UsageReading {
  usage: Usage;
  source: UsageSource;
  /** Date de dernière écriture du fichier, pour dire l'âge de la mesure. */
  at: number;
}

/**
 * Absent, illisible ou vide vaut « pas de mesure », jamais une erreur : ni l'un
 * ni l'autre de ces fichiers n'est garanti d'exister.
 */
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
 * La plus FRAÎCHE des deux sources, jamais la première trouvée.
 *
 * Un ordre de priorité fixe afficherait un pourcentage périmé dès que la source
 * préférée se tait — et les deux se taisent tour à tour : la statusline ne tourne
 * pas dans une session hébergée par l'éditeur, et Vibe Island peut ne pas être
 * installé. C'est la date d'écriture qui tranche, pas une préférence.
 */
export async function readUsage(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageReading | undefined> {
  const [mine, island] = await Promise.all([
    reading(statusFile(home), 'statusline'),
    reading(vibeIslandUsageFile(env), 'vibe-island'),
  ]);
  if (mine === undefined) return island;
  if (island === undefined) return mine;
  return island.at > mine.at ? island : mine;
}
