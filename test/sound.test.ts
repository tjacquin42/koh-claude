import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldChime, statusesOf } from '../src/sound/model';
import { availableSounds, NO_SOUND, playSound } from '../src/sound/player';
import { soundLabel, soundTooltip } from '../src/ui/sound-label';
import type { Session, Status } from '../src/events/types';

const session = (id: string, status: Status): Session => ({
  id, cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode',
  status, toolCount: 0, lastEventAt: 0,
});

const map = (...pairs: Array<[string, Status]>): Map<string, Session> =>
  new Map(pairs.map(([id, s]) => [id, session(id, s)]));

const at = (...pairs: Array<[string, Status]>): Map<string, Status> => statusesOf(map(...pairs));

describe('shouldChime', () => {
  it('sonne quand une session se met à t attendre', () => {
    expect(shouldChime(at(['s1', 'running']), at(['s1', 'waiting']))).toBe(true);
  });

  it('sonne quand une session vient de finir', () => {
    expect(shouldChime(at(['s1', 'running']), at(['s1', 'done_unseen']))).toBe(true);
  });

  it('ne sonne pas pour les bascules qui arrivent toutes seules', () => {
    // Une session passe d elle-même de en cours à l arrêt puis à périmée : un
    // carillon à chaque fois deviendrait un bruit de fond, donc un signal mort.
    expect(shouldChime(at(['s1', 'running']), at(['s1', 'idle']))).toBe(false);
    expect(shouldChime(at(['s1', 'idle']), at(['s1', 'stale']))).toBe(false);
    expect(shouldChime(at(['s1', 'waiting']), at(['s1', 'running']))).toBe(false);
  });

  it('ne sonne pas quand rien ne change', () => {
    expect(shouldChime(at(['s1', 'waiting']), at(['s1', 'waiting']))).toBe(false);
  });

  it('ne sonne JAMAIS au premier rendu', () => {
    // Sinon l éditeur carillonnerait à chaque ouverture de fenêtre, pour des
    // sessions parfois vieilles de plusieurs heures.
    expect(shouldChime(undefined, at(['s1', 'waiting'], ['s2', 'done_unseen']))).toBe(false);
  });

  it('ne sonne pas pour une session qu on découvre : on ignore d où elle vient', () => {
    expect(shouldChime(at(['s1', 'running']), at(['s1', 'running'], ['s2', 'waiting']))).toBe(false);
  });

  it('sonne une seule fois pour plusieurs bascules du même tour', () => {
    expect(shouldChime(at(['s1', 'running'], ['s2', 'running']), at(['s1', 'waiting'], ['s2', 'done_unseen']))).toBe(true);
  });

  it('ignore une session disparue', () => {
    expect(shouldChime(at(['s1', 'waiting']), at())).toBe(false);
  });
});

describe('availableSounds', () => {
  it('liste les sons du dossier, sans extension et triés', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'koh-sons-'));
    for (const f of ['Ping.aiff', 'Basso.aiff', 'Glass.aiff', 'notes.txt']) {
      writeFileSync(join(dir, f), '', 'utf8');
    }
    expect(await availableSounds(dir)).toEqual(['Basso', 'Glass', 'Ping']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rend une liste vide sur un dossier absent, jamais une erreur', async () => {
    expect(await availableSounds('/dossier/qui/n/existe/pas')).toEqual([]);
  });

  it('trouve de vrais sons sur cette machine', async () => {
    // Ancrage réel : si macOS déplaçait ses sons, la liste codée en dur d un
    // autre test ne le dirait pas.
    const sounds = await availableSounds();
    expect(sounds.length).toBeGreaterThan(0);
  });
});

describe('playSound', () => {
  it('ne lance rien quand aucun son n est choisi', () => {
    // Aucune assertion possible sur un process détaché : ce qui compte est
    // qu appeler avec NO_SOUND ne lève pas et ne lance aucun lecteur.
    expect(() => playSound(NO_SOUND)).not.toThrow();
  });

  it('ne lève pas sur un son inexistant', () => {
    expect(() => playSound('SonQuiNExistePas', '/dossier/absent')).not.toThrow();
  });
});

describe('soundLabel', () => {
  it('dit l état courant plutôt qu une invitation vague', () => {
    expect(soundLabel('Ping')).toBe('Son : Ping');
    expect(soundLabel(NO_SOUND)).toBe('Son : aucun');
  });

  it('explique quelles bascules sonnent, et lesquelles non', () => {
    expect(soundTooltip('Ping')).toContain('Ping');
    expect(soundTooltip(NO_SOUND)).toContain('Aucun son');
  });
});
