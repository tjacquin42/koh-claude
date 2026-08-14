import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installableSounds, installSounds, LIBRARY_SOURCES, userSoundsDir } from '../src/sound/library';

const seeded = (files: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'koh-lib-'));
  for (const f of files) writeFileSync(join(dir, f), 'audio', 'utf8');
  return dir;
};

describe('installableSounds', () => {
  it('propose les sons jouables des sources', async () => {
    const src = seeded(['Aurora.m4r', 'Bamboo.m4r', 'notes.txt']);
    const target = seeded([]);
    expect((await installableSounds([src], target)).map((s) => s.name)).toEqual(['Aurora', 'Bamboo']);
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it('ne repropose pas ce qui est déjà là, quelle que soit l extension', async () => {
    // Réinstaller ne doit ni dupliquer, ni écraser un fichier que l utilisateur
    // aurait remplacé par le sien.
    const src = seeded(['Aurora.m4r', 'Bamboo.m4r']);
    const target = seeded(['Aurora.wav']);
    expect((await installableSounds([src], target)).map((s) => s.name)).toEqual(['Bamboo']);
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it('traite un dossier cible absent comme « tout est à ajouter »', async () => {
    const src = seeded(['Aurora.m4r']);
    expect(await installableSounds([src], '/dossier/absent')).toHaveLength(1);
    rmSync(src, { recursive: true, force: true });
  });

  it('ignore une source absente sans perdre les autres', async () => {
    const src = seeded(['Aurora.m4r']);
    const target = seeded([]);
    expect(await installableSounds(['/rien/du/tout', src], target)).toHaveLength(1);
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it('trouve de vraies tonalités sur cette machine', async () => {
    // Ancrage réel : si macOS déplaçait sa bibliothèque, une liste de chemins
    // codés en dur ne le dirait pas.
    const found = await installableSounds(LIBRARY_SOURCES, '/dossier/absent');
    expect(found.length).toBeGreaterThan(20);
  });
});

describe('installSounds', () => {
  it('copie les sons choisis dans la bibliothèque de l utilisateur', async () => {
    const src = seeded(['Aurora.m4r', 'Bamboo.m4r']);
    const target = join(mkdtempSync(join(tmpdir(), 'koh-dest-')), 'Sounds');
    const added = await installSounds(await installableSounds([src], target), target);
    expect(added).toBe(2);
    expect(readdirSync(target).sort()).toEqual(['Aurora.m4r', 'Bamboo.m4r']);
    rmSync(src, { recursive: true, force: true });
  });

  it('poursuit malgré une copie impossible, et dit la vérité sur le compte', async () => {
    const src = seeded(['Aurora.m4r']);
    const target = seeded([]);
    const added = await installSounds(
      [{ name: 'Fantome', path: '/rien/du/tout.m4r' }, { name: 'Aurora', path: join(src, 'Aurora.m4r') }],
      target,
    );
    expect(added).toBe(1);
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
});

describe('userSoundsDir', () => {
  it('vise l emplacement que macOS lit lui-même', () => {
    expect(userSoundsDir('/Users/dev')).toBe('/Users/dev/Library/Sounds');
  });
});
