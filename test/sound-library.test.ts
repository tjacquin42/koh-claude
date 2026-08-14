import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installedCount,
  installLibrary,
  LIBRARY,
  libraryLabel,
  librarySoundsDir,
  removeLibrary,
  type LibraryDeps,
} from '../src/sound/library';
import { soundDirs } from '../src/sound/player';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'koh-lib-'));

/**
 * Une archive factice : `extract` dépose les fichiers demandés là où
 * `installLibrary` les cherchera. Le vrai `tar` n'est pas dans la boucle — ce
 * qu'on éprouve ici, c'est le nommage et le compte, pas le déballage.
 */
const fake = (files: string[]): LibraryDeps & { work?: string } => {
  const deps: LibraryDeps & { work?: string } = {
    download: async () => new Uint8Array([1, 2, 3]),
    extract: async (_archive, into) => {
      deps.work = into;
      const dir = join(into, 'repo-sha', 'addons', 'kenney_interface_sounds');
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(join(dir, f), 'audio', 'utf8');
    },
  };
  return deps;
};

describe('libraryLabel', () => {
  it('donne un nom lisible, stable d une installation à l autre', () => {
    expect(libraryLabel('select_003.wav')).toBe('Sélection 3');
    expect(libraryLabel('confirmation_001.wav')).toBe('Confirmation 1');
    expect(libraryLabel('/ailleurs/toggle_004.wav')).toBe('Interrupteur 4');
  });

  it('écarte ce qu il ne sait pas nommer plutôt que d inventer', () => {
    // Une famille inconnue donnerait une ligne « bong_001 » dans la liste de
    // choix : une bibliothèque un peu plus courte vaut mieux.
    expect(libraryLabel('inconnu_001.wav')).toBeUndefined();
    expect(libraryLabel('select.wav')).toBeUndefined();
    expect(libraryLabel('select_abc.wav')).toBeUndefined();
    expect(libraryLabel('select_000.wav')).toBeUndefined();
  });
});

describe('la bibliothèque proposée', () => {
  it('est épinglée sur un commit, jamais sur une branche', () => {
    // Un dépôt tiers peut changer d avis. « La bibliothèque a changé sous nos
    // pieds » ne se verrait qu au moment où un son cesse de ressembler à ce que
    // l utilisateur avait choisi.
    expect(LIBRARY.url).toMatch(/\/[0-9a-f]{40}$/);
    expect(LIBRARY.url).not.toMatch(/master|main|HEAD/);
  });

  it('annonce sa licence et son auteur : c est ce qui autorise la copie', () => {
    expect(LIBRARY.license).toBe('CC0 1.0');
    expect(LIBRARY.author.length).toBeGreaterThan(0);
  });

  it('se pose chez nous, pas dans le dossier de sons du système', () => {
    // ~/Library/Sounds est lu par le panneau Son de macOS : y déverser cent
    // fichiers rendrait sa liste inutilisable pour un réglage qui ne concerne
    // que cette extension.
    expect(librarySoundsDir('/racine')).toBe(join('/racine', 'sounds'));
    expect(librarySoundsDir('/racine')).not.toContain('Library');
  });

  it('est cherchée en DERNIER, pour ne jamais supplanter un son de l utilisateur', () => {
    const dirs = soundDirs('/racine');
    expect(dirs[dirs.length - 1]).toBe(librarySoundsDir('/racine'));
    expect(dirs.indexOf(join('/racine', 'sounds'))).toBeGreaterThan(dirs.findIndex((d) => d.includes('Library')));
  });
});

describe('installLibrary', () => {
  it('pose les sons sous leur nom lisible, et compte juste', async () => {
    const target = join(scratch(), 'sounds');
    const deps = fake(['select_003.wav', 'error_002.wav', 'LICENSE.txt']);
    expect(await installLibrary(target, deps)).toBe(2);
    expect(readdirSync(target).sort()).toEqual(['Erreur 2.wav', 'Sélection 3.wav']);
    rmSync(target, { recursive: true, force: true });
  });

  it('n installe pas ce qu il ne sait pas nommer', async () => {
    const target = join(scratch(), 'sounds');
    expect(await installLibrary(target, fake(['select_001.wav', 'zarbi_001.wav']))).toBe(1);
    expect(readdirSync(target)).toEqual(['Sélection 1.wav']);
    rmSync(target, { recursive: true, force: true });
  });

  it('rend zéro quand l archive est hors d atteinte, sans rien créer', async () => {
    // Réseau coupé : le tableau de bord doit rester utilisable sans son.
    const target = join(scratch(), 'sounds');
    const deps: LibraryDeps = { download: async () => undefined, extract: fake([]).extract };
    expect(await installLibrary(target, deps)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('rend zéro quand le déballage échoue, sans lever', async () => {
    const target = join(scratch(), 'sounds');
    const deps: LibraryDeps = {
      download: async () => new Uint8Array([1]),
      extract: async () => {
        throw new Error('tar introuvable');
      },
    };
    await expect(installLibrary(target, deps)).resolves.toBe(0);
  });

  it('nettoie son dossier temporaire, réussite comme échec', async () => {
    // L archive fait près de deux mégaoctets : un échec ne doit pas les laisser
    // derrière lui, tour après tour.
    const target = join(scratch(), 'sounds');
    const ok = fake(['select_001.wav']);
    await installLibrary(target, ok);
    expect(ok.work).toBeDefined();
    expect(existsSync(ok.work as string)).toBe(false);

    const ko = fake(['select_001.wav']);
    const boom: LibraryDeps = {
      download: ko.download,
      extract: async (archive, into) => {
        await ko.extract(archive, into);
        throw new Error('boum');
      },
    };
    await installLibrary(target, boom);
    expect(existsSync(ko.work as string)).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });
});

describe('installedCount et removeLibrary', () => {
  it('comptent ce qui est posé, et un dossier absent vaut zéro', async () => {
    const target = join(scratch(), 'sounds');
    expect(await installedCount(target)).toBe(0);
    await installLibrary(target, fake(['select_001.wav', 'error_001.wav']));
    expect(await installedCount(target)).toBe(2);
    rmSync(target, { recursive: true, force: true });
  });

  it('retirent la bibliothèque entière, et disent combien', async () => {
    const target = join(scratch(), 'sounds');
    await installLibrary(target, fake(['select_001.wav', 'error_001.wav']));
    expect(await removeLibrary(target)).toBe(2);
    expect(existsSync(target)).toBe(false);
    // Deux fois de suite : retirer ce qui n est plus là ne doit pas lever.
    expect(await removeLibrary(target)).toBe(0);
  });
});
