import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type AppSettings, defaultSettings, parseSettings, serializeSettings } from './model';

let seq = 0;

/** Un fichier absent ou illisible vaut « réglages par défaut ». Ne lève jamais. */
export async function readSettings(file: string): Promise<AppSettings> {
  try {
    return parseSettings(await readFile(file, 'utf8'));
  } catch {
    return defaultSettings();
  }
}

/**
 * Écrit un ou plusieurs champs, en relisant juste avant.
 *
 * Pas de fusion à trois voies comme pour le classement : trois valeurs
 * scalaires, changées à la main, une fenêtre à la fois. La relecture suffit à
 * ce qu'une fenêtre qui règle le volume n'écrase pas le son qu'une autre vient
 * de choisir.
 */
export async function writeSettings(file: string, patch: Partial<AppSettings>): Promise<AppSettings> {
  const merged: AppSettings = { ...(await readSettings(file)), ...patch };
  const tmp = join(dirname(file), `.tmp-settings-${process.pid}-${(seq += 1)}`);
  try {
    await writeFile(tmp, serializeSettings(merged), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return merged;
}

/**
 * Pose le fichier partagé s'il n'existe pas encore, à partir de ce que cet
 * éditeur avait dans ses propres réglages.
 *
 * Ne fait rien si le fichier est là : le premier éditeur qui démarre après la
 * migration fixe la valeur, les suivants la lisent. Sans cette garde, chaque
 * démarrage réimposerait les réglages locaux de SON éditeur, et les deux
 * continueraient de se contredire — en pire, puisqu'ils se battraient.
 */
export async function seedSettings(file: string, from: () => AppSettings): Promise<AppSettings> {
  try {
    return parseSettings(await readFile(file, 'utf8'));
  } catch {
    return writeSettings(file, from());
  }
}
