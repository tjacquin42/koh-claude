import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** Là où macOS range ses sons système. Rien à installer, rien à embarquer dans le paquet. */
export const SYSTEM_SOUNDS = '/System/Library/Sounds';

/** Ce que vaut « pas de son » dans le réglage : une chaîne vide, pas une absence. */
export const NO_SOUND = '';

/**
 * Les sons proposés, lus sur la machine plutôt que codés en dur : la liste varie
 * d'une version de macOS à l'autre, et proposer un son absent ne produirait
 * qu'un silence inexplicable.
 *
 * Dossier illisible ou inexistant (autre système) : liste vide, et l'appelant
 * dira qu'il n'y a rien à choisir — jamais une erreur.
 */
export async function availableSounds(dir: string = SYSTEM_SOUNDS): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => extname(f).toLowerCase() === '.aiff')
      .map((f) => basename(f, extname(f)))
      .sort((a, b) => a.localeCompare(b, 'fr'));
  } catch {
    return [];
  }
}

/**
 * Joue un son, et n'échoue jamais bruyamment : un carillon raté ne doit pas
 * remonter une erreur à l'utilisateur — le tableau de bord reste utilisable
 * sans son.
 *
 * `execFile` et non `exec` : le nom vient d'un réglage, donc de l'extérieur, et
 * ne doit jamais traverser un shell.
 */
export function playSound(name: string, dir: string = SYSTEM_SOUNDS): void {
  if (name === NO_SOUND) return;
  execFile('/usr/bin/afplay', [join(dir, `${name}.aiff`)], () => undefined);
}
