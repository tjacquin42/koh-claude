import { readFile } from 'node:fs/promises';
import { statusFile } from '../paths';
import { parseUsage, type Usage } from './model';

/**
 * Absent, illisible ou vide vaut « pas de mesure », jamais une erreur : la même
 * règle que le classement (groups/store.ts). Le fichier n'existe pas tant que le
 * pont de statusline n'est pas installé, et ce n'est pas une anomalie.
 */
export async function readUsage(home: string): Promise<Usage | undefined> {
  try {
    return parseUsage(JSON.parse(await readFile(statusFile(home), 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}
