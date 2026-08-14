import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * Une bibliothèque proposée, jamais imposée — et jamais embarquée.
 *
 * Embarquer des fichiers audio dans le paquet aurait deux coûts : le poids, et
 * la licence de chacun d'eux dans un dépôt public. On les récupère donc à la
 * demande, une seule fois, si l'utilisateur le veut.
 *
 * Le choix s'est porté sur les sons d'interface de Kenney : cent sons courts
 * (aucun ne dépasse trois dixièmes de seconde), pensés pour une interface et
 * non pour une sonnerie de téléphone, et placés en CC0 — donc utilisables et
 * redistribuables sans condition, ce qui n'était vrai d'aucune tonalité du
 * système.
 *
 * L'archive est épinglée sur un COMMIT, jamais sur une branche : un dépôt tiers
 * peut changer d'avis, et « la bibliothèque a changé sous nos pieds » est un
 * défaut qu'on ne verrait qu'au moment où un son se met à ne plus ressembler à
 * ce que l'utilisateur avait choisi.
 */
export interface LibraryInfo {
  name: string;
  author: string;
  license: string;
  homepage: string;
  url: string;
  /** Ce que l'archive doit contenir : sert à annoncer un chiffre avant de télécharger. */
  count: number;
}

const COMMIT = '4596a49eaf5a533948d49a47467f606bcdea70ff';

export const LIBRARY: LibraryInfo = {
  name: 'Kenney Interface Sounds',
  author: 'Kenney',
  license: 'CC0 1.0',
  homepage: 'https://kenney.nl/assets/interface-sounds',
  url: `https://codeload.github.com/Calinou/kenney-interface-sounds/tar.gz/${COMMIT}`,
  count: 100,
};

/**
 * Où atterrit la bibliothèque : chez nous, pas dans `~/Library/Sounds`.
 *
 * `~/Library/Sounds` est lu par le panneau Son de macOS : y déverser cent
 * fichiers rendrait la liste des sons d'alerte du système inutilisable, pour un
 * réglage qui ne concerne que cette extension. Un dossier à nous se désinstalle
 * aussi d'un seul geste, sans avoir à deviner lesquels des fichiers présents
 * venaient de nous.
 */
export function librarySoundsDir(home: string): string {
  return join(home, 'sounds');
}

/**
 * Les familles de l'archive, et leur nom en clair.
 *
 * Une famille absente de cette table n'est pas installée : mieux vaut une
 * bibliothèque un peu plus courte qu'une liste où figurent des `bong_001`.
 */
const FAMILIES: Readonly<Record<string, string>> = {
  back: 'Retour',
  bong: 'Bong',
  click: 'Clic',
  close: 'Fermeture',
  confirmation: 'Confirmation',
  drop: 'Chute',
  error: 'Erreur',
  glass: 'Verre',
  glitch: 'Glitch',
  maximize: 'Montée',
  minimize: 'Descente',
  open: 'Ouverture',
  pluck: 'Pincement',
  question: 'Question',
  scratch: 'Scratch',
  scroll: 'Défilement',
  select: 'Sélection',
  switch: 'Bascule',
  tick: 'Tic',
  toggle: 'Interrupteur',
};

/**
 * Le nom sous lequel un fichier de l'archive entre dans la bibliothèque.
 *
 * `select_003.wav` devient « Sélection 3 » : c'est ce nom qui s'affiche dans la
 * liste de choix ET qui est écrit dans les réglages, donc il doit être stable
 * d'une installation à l'autre — d'où une table figée plutôt qu'une jolie
 * transformation du nom d'origine, qui bougerait au premier renommage en amont.
 */
export function libraryLabel(file: string): string | undefined {
  const stem = basename(file, extname(file));
  const cut = stem.lastIndexOf('_');
  if (cut <= 0) return undefined;
  const label = FAMILIES[stem.slice(0, cut)];
  if (label === undefined) return undefined;
  const index = Number.parseInt(stem.slice(cut + 1), 10);
  if (!Number.isInteger(index) || index <= 0) return undefined;
  return `${label} ${index}`;
}

export interface LibraryDeps {
  /** Retourne le contenu de l'archive, ou `undefined` si elle est hors d'atteinte. */
  download: (url: string) => Promise<Uint8Array | undefined>;
  /** Déballe l'archive dans un dossier. */
  extract: (archive: string, into: string) => Promise<void>;
}

async function download(url: string): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * `execFile` et non `exec` : les chemins sont construits ici, mais une archive
 * ne doit jamais approcher un shell, quelle qu'en soit la provenance.
 */
function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tar', ['-xzf', archive, '-C', into], (err) =>
      err === null ? resolve() : reject(err),
    );
  });
}

export const defaultLibraryDeps: LibraryDeps = { download, extract };

async function wavFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await wavFiles(full)));
    else if (extname(entry.name).toLowerCase() === '.wav') out.push(full);
  }
  return out.sort();
}

/** Combien de sons de la bibliothèque sont déjà posés. */
export async function installedCount(target: string): Promise<number> {
  try {
    return (await readdir(target)).filter((f) => extname(f).toLowerCase() === '.wav').length;
  } catch {
    return 0;
  }
}

/**
 * Récupère la bibliothèque et la pose. Retourne le nombre de sons installés.
 *
 * Ne lève jamais : réseau coupé, `tar` absent, disque plein — tout retombe sur
 * zéro. Une bibliothèque manquante n'empêche pas le tableau de bord de servir,
 * et un carillon raté ne vaut pas une fenêtre d'erreur.
 *
 * Le dossier temporaire est nettoyé quoi qu'il arrive : l'archive fait près de
 * deux mégaoctets, et un échec ne doit pas les laisser derrière lui.
 */
export async function installLibrary(
  target: string,
  deps: LibraryDeps = defaultLibraryDeps,
): Promise<number> {
  const bytes = await deps.download(LIBRARY.url);
  if (bytes === undefined || bytes.length === 0) return 0;
  let work: string | undefined;
  try {
    work = await mkdtemp(join(tmpdir(), 'koh-vibe-sounds-'));
    const archive = join(work, 'library.tar.gz');
    await writeFile(archive, bytes);
    await deps.extract(archive, work);
    await mkdir(target, { recursive: true });
    let added = 0;
    for (const file of await wavFiles(work)) {
      const label = libraryLabel(file);
      if (label === undefined) continue;
      try {
        // Copie plutôt que déplacement : le temporaire et la cible peuvent
        // vivre sur deux volumes, où `rename` échouerait.
        await writeFile(join(target, `${label}.wav`), await readFile(file));
        added += 1;
      } catch {
        continue;
      }
    }
    return added;
  } catch {
    return 0;
  } finally {
    if (work !== undefined) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Retire la bibliothèque. Retourne le nombre de fichiers effacés. */
export async function removeLibrary(target: string): Promise<number> {
  const count = await installedCount(target);
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  return count;
}
