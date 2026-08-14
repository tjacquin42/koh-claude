import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * Une bibliothèque proposée, jamais imposée — et jamais embarquée.
 *
 * Embarquer des fichiers audio dans le paquet aurait deux coûts : le poids, et
 * la licence de chacun d'eux dans un dépôt public. Les télécharger en
 * ajouterait un troisième : dépendre d'un hébergeur qui peut disparaître.
 *
 * macOS porte déjà, hors des quatorze sons classiques, une quarantaine de
 * tonalités d'alerte — courtes, faites pour notifier. On les propose à la copie
 * dans `~/Library/Sounds`, l'emplacement prévu par le système : rien ne
 * transite par le réseau, rien n'est redistribué, et l'utilisateur reste maître
 * de son dossier.
 */
const TONES = '/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones';

export const LIBRARY_SOURCES: readonly string[] = [join(TONES, 'Modern'), join(TONES, 'Classic')];

/** Où les sons de l'utilisateur vivent : celui que macOS lit, et nous avec. */
export function userSoundsDir(home: string = homedir()): string {
  return join(home, 'Library', 'Sounds');
}

const PLAYABLE = new Set(['.m4r', '.aiff', '.aif', '.wav', '.m4a', '.mp3', '.caf']);

export interface Installable {
  name: string;
  path: string;
}

/**
 * Ce qu'on peut ajouter, et qui n'est pas déjà là.
 *
 * Un son déjà présent n'est pas reproposé : réinstaller ne doit ni dupliquer,
 * ni écraser un fichier que l'utilisateur aurait remplacé par le sien.
 */
export async function installableSounds(
  sources: readonly string[] = LIBRARY_SOURCES,
  target: string = userSoundsDir(),
): Promise<Installable[]> {
  const already = new Set<string>();
  try {
    for (const f of await readdir(target)) already.add(basename(f, extname(f)));
  } catch {
    // Dossier absent : tout est à ajouter.
  }
  const found = new Map<string, Installable>();
  for (const dir of sources) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!PLAYABLE.has(extname(file).toLowerCase())) continue;
      const name = basename(file, extname(file));
      if (already.has(name) || found.has(name)) continue;
      found.set(name, { name, path: join(dir, file) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Copie les sons choisis. Retourne le nombre effectivement ajouté : une copie
 * qui échoue (permission, disque plein) n'interrompt pas les autres — mieux
 * vaut une bibliothèque partielle qu'aucune, et le compte dit la vérité.
 */
export async function installSounds(
  entries: readonly Installable[],
  target: string = userSoundsDir(),
): Promise<number> {
  try {
    await mkdir(target, { recursive: true });
  } catch {
    return 0;
  }
  let added = 0;
  for (const entry of entries) {
    try {
      await copyFile(entry.path, join(target, basename(entry.path)));
      added += 1;
    } catch {
      continue;
    }
  }
  return added;
}
