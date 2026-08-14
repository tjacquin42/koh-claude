import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Status } from '../src/events/types';
import { STATUS_ICON_DIR, statusIconPath } from '../src/ui/status-icon';

const ALL: readonly Status[] = ['running', 'waiting', 'done_unseen', 'idle', 'stale'];
const ROOT = join(__dirname, '..');

describe('statusIconPath', () => {
  it('donne une paire light/dark à chaque statut, sans exception', () => {
    for (const status of ALL) {
      const paths = statusIconPath('/ext', status);
      expect(paths.light, `statut ${status}`).toMatch(/\.svg$/);
      expect(paths.dark, `statut ${status}`).toMatch(/\.svg$/);
      expect(paths.light, `statut ${status}`).not.toBe(paths.dark);
    }
  });

  it('ne donne jamais le même fichier à deux statuts différents', () => {
    const seen = ALL.flatMap((s) => Object.values(statusIconPath('/ext', s)));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('se range sous la racine du paquet qu on lui donne', () => {
    expect(statusIconPath('/ext', 'running').dark.startsWith(join('/ext', 'resources', STATUS_ICON_DIR))).toBe(true);
  });

  // Le test qui compte vraiment : une table qui nomme un fichier absent produit
  // une ligne SANS icône, et la pastille est le seul endroit où le statut se lit.
  // Un statut ajouté sans repasser par scripts/make-status-icons.cjs doit se
  // voir ici, pas dans la barre latérale de l utilisateur.
  it('nomme des fichiers qui existent réellement dans le paquet', async () => {
    for (const status of ALL) {
      const paths = statusIconPath(ROOT, status);
      for (const file of [paths.light, paths.dark]) {
        await expect(access(file), `${status} → ${file}`).resolves.toBeUndefined();
      }
    }
  });
});
