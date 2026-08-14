import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommit, readBuildStamp, releaseLabel, versionLabel } from '../src/ui/version';

describe('releaseLabel', () => {
  it('rend la version livrée telle qu\'elle est taguée', () => {
    expect(releaseLabel({ version: 'v0.2.0', ahead: 0 })).toBe('v0.2.0');
  });

  it('compte les commits qui suivent la dernière livraison', () => {
    expect(releaseLabel({ version: 'v0.2.0', ahead: 7 })).toBe('v0.2.0+7');
  });

  it('n\'invente pas d\'écart quand le compte manque ou n\'en est pas un', () => {
    expect(releaseLabel({ version: 'v0.2.0' })).toBe('v0.2.0');
    expect(releaseLabel({ version: 'v0.2.0', ahead: '7' })).toBe('v0.2.0');
    expect(releaseLabel({ version: 'v0.2.0', ahead: -1 })).toBe('v0.2.0');
  });

  it('sans tag, il n\'y a aucune version à afficher', () => {
    expect(releaseLabel({ ahead: 7 })).toBeUndefined();
    expect(releaseLabel({ version: '' })).toBeUndefined();
    expect(releaseLabel(null)).toBeUndefined();
    expect(releaseLabel(undefined)).toBeUndefined();
    expect(releaseLabel('v0.2.0')).toBeUndefined();
  });
});

describe('buildCommit', () => {
  it('rend le commit tel quel quand le paquet lui correspond', () => {
    expect(buildCommit({ commit: '1736ec0', dirty: false })).toBe('1736ec0');
  });

  it('marque d\'une étoile un paquet qui ne correspond pas à son commit', () => {
    expect(buildCommit({ commit: '1736ec0', dirty: true })).toBe('1736ec0*');
  });

  it('ne marque que sur un vrai booléen : une valeur douteuse ne vaut pas une alerte', () => {
    expect(buildCommit({ commit: '1736ec0', dirty: 'oui' })).toBe('1736ec0');
    expect(buildCommit({ commit: '1736ec0' })).toBe('1736ec0');
  });

  it('sans commit, il n\'y a rien à afficher — pas même une étoile', () => {
    expect(buildCommit({ dirty: true })).toBeUndefined();
    expect(buildCommit({ commit: '' })).toBeUndefined();
    expect(buildCommit(null)).toBeUndefined();
  });
});

describe('versionLabel', () => {
  it('accole la version livrée et le commit', () => {
    expect(versionLabel({ version: 'v0.2.0', ahead: 0, commit: '1736ec0', dirty: false })).toBe('v0.2.0 · 1736ec0');
  });

  it('porte l\'écart et l\'étoile ensemble quand les deux ont lieu d\'être', () => {
    expect(versionLabel({ version: 'v0.2.0', ahead: 3, commit: '1736ec0', dirty: true })).toBe('v0.2.0+3 · 1736ec0*');
  });

  it('dit qu\'aucune version n\'a été livrée plutôt que d\'en emprunter une', () => {
    expect(versionLabel({ commit: '1736ec0', dirty: false })).toBe('sans version · 1736ec0');
  });

  it('reste affichable sans horodatage du tout', () => {
    expect(versionLabel(undefined)).toBe('sans version');
  });
});

describe('readBuildStamp', () => {
  it('lit le fichier posé à la racine du paquet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koh-version-'));
    await writeFile(join(dir, 'build-info.json'), '{"commit":"abc1234","dirty":false}', 'utf8');
    expect(await readBuildStamp(dir)).toEqual({ commit: 'abc1234', dirty: false });
  });

  it('traite un fichier absent ou illisible comme une absence, jamais comme une erreur', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koh-version-'));
    expect(await readBuildStamp(dir)).toBeUndefined();
    await writeFile(join(dir, 'build-info.json'), 'ce n\'est pas du JSON', 'utf8');
    expect(await readBuildStamp(dir)).toBeUndefined();
  });
});
