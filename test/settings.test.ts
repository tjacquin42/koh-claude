import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, serializeSettings } from '../src/settings/model';
import { readSettings, seedSettings, writeSettings } from '../src/settings/store';
import { settingsFile } from '../src/paths';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'koh-set-'));

describe('parseSettings', () => {
  it('lit ce qui est écrit', () => {
    expect(parseSettings('{"waiting":"Clic 1","done":"Verre 2","volume":0.3}')).toEqual({
      waiting: 'Clic 1',
      done: 'Verre 2',
      volume: 0.3,
    });
  });

  it('retombe sur les valeurs par défaut quand le fichier est illisible', () => {
    expect(parseSettings('pas du json')).toEqual(defaultSettings());
    expect(parseSettings('[]')).toEqual(defaultSettings());
  });

  it('rattrape chaque champ SÉPARÉMENT', () => {
    // Un volume abîmé ne doit pas emporter le choix des sons avec lui : sinon
    // une seule valeur fausse fait croire que tout le réglage a été perdu.
    const s = parseSettings('{"waiting":"Clic 1","volume":"beaucoup"}');
    expect(s.waiting).toBe('Clic 1');
    expect(s.volume).toBe(defaultSettings().volume);
  });

  it('garde le silence choisi, qui n est pas une absence de choix', () => {
    expect(parseSettings('{"waiting":""}').waiting).toBe('');
  });

  it('fait le tour du fichier', () => {
    const s = { waiting: 'Clic 1', done: '', volume: 0.9 };
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });
});

describe('le fichier de réglages partagé', () => {
  it('vit à la racine de l état, à côté du classement', () => {
    // C est ce qui le rend commun aux éditeurs : la même machine ne doit pas
    // annoncer deux carillons différents selon la fenêtre d où on la regarde.
    expect(settingsFile('/racine')).toBe(join('/racine', 'settings.json'));
  });

  it('vaut les valeurs par défaut quand il n existe pas', async () => {
    expect(await readSettings(join(scratch(), 'absent.json'))).toEqual(defaultSettings());
  });

  it('écrit un champ sans effacer les autres', async () => {
    const file = join(scratch(), 'settings.json');
    await writeSettings(file, { waiting: 'Clic 1', done: 'Verre 2', volume: 0.4 });
    await writeSettings(file, { volume: 0.8 });
    expect(await readSettings(file)).toEqual({ waiting: 'Clic 1', done: 'Verre 2', volume: 0.8 });
  });

  it('relit avant d écrire : régler le volume n écrase pas un son choisi entre-temps', async () => {
    const file = join(scratch(), 'settings.json');
    await writeSettings(file, { waiting: 'Clic 1' });
    // Une autre fenêtre écrit pendant qu on tient encore l ancien état en main.
    writeFileSync(file, serializeSettings({ waiting: 'Erreur 3', done: '', volume: 0.5 }), 'utf8');
    await writeSettings(file, { volume: 0.2 });
    expect((await readSettings(file)).waiting).toBe('Erreur 3');
  });

  it('ne laisse pas de fichier temporaire derrière lui', async () => {
    const dir = scratch();
    const file = join(dir, 'settings.json');
    await writeSettings(file, { volume: 0.1 });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual(['settings.json']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('seedSettings — la migration depuis les réglages de chaque éditeur', () => {
  it('verse les réglages locaux quand le fichier partagé n existe pas encore', async () => {
    const file = join(scratch(), 'settings.json');
    const seeded = await seedSettings(file, () => ({ waiting: 'Funk', done: 'Hero', volume: 0.7 }));
    expect(seeded.waiting).toBe('Funk');
    expect(JSON.parse(readFileSync(file, 'utf8')).done).toBe('Hero');
  });

  it('ne touche à RIEN quand le fichier est déjà là', async () => {
    // Sans cette garde, chaque démarrage réimposerait les réglages locaux de SON
    // éditeur : les deux ne se contrediraient plus seulement, ils se battraient.
    const file = join(scratch(), 'settings.json');
    await writeSettings(file, { waiting: 'Clic 1', done: 'Verre 2', volume: 0.3 });
    const kept = await seedSettings(file, () => ({ waiting: 'Funk', done: 'Hero', volume: 0.7 }));
    expect(kept).toEqual({ waiting: 'Clic 1', done: 'Verre 2', volume: 0.3 });
  });

  it('sème même un silence choisi, qui est un réglage comme un autre', async () => {
    const file = join(scratch(), 'settings.json');
    expect((await seedSettings(file, () => ({ waiting: '', done: '', volume: 0.5 }))).waiting).toBe('');
    expect((await readSettings(file)).waiting).toBe('');
  });
});
