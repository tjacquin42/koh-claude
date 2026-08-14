import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { readdir } from 'node:fs/promises';

/**
 * Où l'on cherche les sons.
 *
 * Les sons système d'abord, puis ceux de l'utilisateur : `~/Library/Sounds` est
 * l'emplacement prévu par macOS pour en ajouter, et c'est ce qui donne une
 * bibliothèque sans limite sans embarquer de fichiers audio dans le paquet —
 * ni en discuter la licence dans un dépôt public.
 */
export const SOUND_DIRS = ['/System/Library/Sounds', join(homedir(), 'Library', 'Sounds')];

/** Ce qu'`afplay` sait lire, et qui a un sens comme notification. */
const PLAYABLE = new Set(['.aiff', '.aif', '.wav', '.m4a', '.m4r', '.mp3', '.caf']);

/** Ce que vaut « pas de son » dans un réglage : une chaîne vide, pas une absence. */
export const NO_SOUND = '';

/** Volume par défaut : audible sans faire sursauter. */
export const DEFAULT_VOLUME = 0.5;

export interface SoundEntry {
  name: string;
  path: string;
}

/**
 * Les sons disponibles, lus sur la machine plutôt que codés en dur : la liste
 * varie d'une version de macOS à l'autre, et l'utilisateur peut en déposer.
 *
 * Un dossier absent ou illisible ne vaut jamais une erreur — sur un autre
 * système, les deux le sont, et la liste est simplement vide.
 *
 * Les doublons de nom sont résolus en faveur du PREMIER dossier trouvé, donc
 * du système : un fichier personnel homonyme ne remplace pas silencieusement un
 * son que l'utilisateur croit connaître.
 */
export async function availableSounds(dirs: readonly string[] = SOUND_DIRS): Promise<SoundEntry[]> {
  const seen = new Map<string, SoundEntry>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (!PLAYABLE.has(ext)) continue;
      const name = basename(file, extname(file));
      if (!seen.has(name)) seen.set(name, { name, path: join(dir, file) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Ramène un volume à ce qu'`afplay` accepte. Une valeur absente ou aberrante
 * retombe sur la valeur par défaut plutôt que sur le silence : un réglage
 * abîmé ne doit pas se traduire par « le son ne marche plus », qui enverrait
 * chercher la panne ailleurs.
 */
export function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

/**
 * Joue un fichier, et n'échoue jamais bruyamment : un carillon raté ne doit pas
 * remonter d'erreur — le tableau de bord reste utilisable sans son.
 *
 * `execFile` et non `exec` : le chemin vient d'un réglage, donc de l'extérieur,
 * et ne doit jamais traverser un shell.
 */
export function playFile(path: string, volume: number): void {
  execFile('/usr/bin/afplay', ['-v', String(clampVolume(volume)), path], () => undefined);
}

/** Joue un son par son nom, en le résolvant dans les dossiers connus. */
export async function playNamed(
  name: string,
  volume: number,
  dirs: readonly string[] = SOUND_DIRS,
): Promise<void> {
  if (name === NO_SOUND) return;
  const found = (await availableSounds(dirs)).find((s) => s.name === name);
  if (found !== undefined) playFile(found.path, volume);
}
