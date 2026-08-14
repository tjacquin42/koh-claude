import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chimeFor, statusesOf } from '../src/sound/model';
import { availableSounds, clampVolume, DEFAULT_VOLUME, NO_SOUND, playFile, playNamed } from '../src/sound/player';
import { FooterTree, soundRowLabel, volumeRowLabel } from '../src/ui/footer-tree';
import type { Session, Status } from '../src/events/types';

const session = (id: string, status: Status): Session => ({
  id, cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode',
  status, toolCount: 0, lastEventAt: 0,
});

const map = (...pairs: Array<[string, Status]>): Map<string, Session> =>
  new Map(pairs.map(([id, s]) => [id, session(id, s)]));

const at = (...pairs: Array<[string, Status]>): Map<string, Status> => statusesOf(map(...pairs));

describe('chimeFor', () => {
  it('distingue les deux événements, pour deux sons différents', () => {
    expect(chimeFor(at(['s1', 'running']), at(['s1', 'waiting']))).toEqual({ event: 'waiting', sessionId: 's1' });
    expect(chimeFor(at(['s1', 'running']), at(['s1', 'done_unseen']))).toEqual({ event: 'done', sessionId: 's1' });
  });

  it('ne sonne pas pour les bascules qui arrivent toutes seules', () => {
    // Une session passe d elle-même de en cours à l arrêt puis à périmée : un
    // carillon à chaque fois deviendrait un bruit de fond, donc un signal mort.
    expect(chimeFor(at(['s1', 'running']), at(['s1', 'idle']))).toBeUndefined();
    expect(chimeFor(at(['s1', 'idle']), at(['s1', 'stale']))).toBeUndefined();
    expect(chimeFor(at(['s1', 'waiting']), at(['s1', 'running']))).toBeUndefined();
  });

  it('ne sonne pas quand rien ne change', () => {
    expect(chimeFor(at(['s1', 'waiting']), at(['s1', 'waiting']))).toBeUndefined();
  });

  it('ne sonne JAMAIS au premier rendu', () => {
    // Sinon l éditeur carillonnerait à chaque ouverture de fenêtre, pour des
    // sessions parfois vieilles de plusieurs heures.
    expect(chimeFor(undefined, at(['s1', 'waiting'], ['s2', 'done_unseen']))).toBeUndefined();
  });

  it('ne sonne pas pour une session qu on découvre : on ignore d où elle vient', () => {
    expect(chimeFor(at(['s1', 'running']), at(['s1', 'running'], ['s2', 'waiting']))).toBeUndefined();
  });

  it('ne joue qu un son par tour, et « t attend » l emporte', () => {
    // Deux carillons simultanés ne s entendent pas mieux qu un ; celui qui
    // demande quelque chose passe devant celui qui informe.
    expect(chimeFor(at(['s1', 'running'], ['s2', 'running']), at(['s1', 'done_unseen'], ['s2', 'waiting']))?.event).toBe('waiting');
    expect(chimeFor(at(['s1', 'running'], ['s2', 'running']), at(['s1', 'waiting'], ['s2', 'done_unseen']))).toEqual({ event: 'waiting', sessionId: 's1' });
  });

  it('ignore une session disparue', () => {
    expect(chimeFor(at(['s1', 'waiting']), at())).toBeUndefined();
  });
});

describe('availableSounds', () => {
  const seeded = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'koh-sons-'));
    for (const f of files) writeFileSync(join(dir, f), '', 'utf8');
    return dir;
  };

  it('liste les sons jouables, sans extension et triés', async () => {
    const dir = seeded(['Ping.aiff', 'Basso.wav', 'Glass.m4a', 'notes.txt', 'doc.pdf']);
    expect((await availableSounds([dir])).map((s) => s.name)).toEqual(['Basso', 'Glass', 'Ping']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('réunit plusieurs dossiers : le système et celui de l utilisateur', async () => {
    const systeme = seeded(['Ping.aiff']);
    const perso = seeded(['MonSon.wav']);
    expect((await availableSounds([systeme, perso])).map((s) => s.name)).toEqual(['MonSon', 'Ping']);
    rmSync(systeme, { recursive: true, force: true });
    rmSync(perso, { recursive: true, force: true });
  });

  it('en cas d homonyme, garde celui du premier dossier — le système', async () => {
    // Un fichier personnel ne doit pas remplacer en silence un son que
    // l utilisateur croit connaître.
    const systeme = seeded(['Ping.aiff']);
    const perso = seeded(['Ping.wav']);
    const found = await availableSounds([systeme, perso]);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(join(systeme, 'Ping.aiff'));
    rmSync(systeme, { recursive: true, force: true });
    rmSync(perso, { recursive: true, force: true });
  });

  it('ignore un dossier absent sans perdre les autres', async () => {
    const dir = seeded(['Ping.aiff']);
    expect((await availableSounds(['/dossier/absent', dir])).map((s) => s.name)).toEqual(['Ping']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('trouve de vrais sons sur cette machine', async () => {
    // Ancrage réel : si macOS déplaçait ses sons, une liste codée en dur ne le
    // dirait pas.
    expect((await availableSounds()).length).toBeGreaterThan(0);
  });
});

describe('clampVolume', () => {
  it('ramène dans les bornes', () => {
    expect(clampVolume(0.3)).toBe(0.3);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(9)).toBe(1);
  });

  it('retombe sur la valeur par défaut, jamais sur le silence', () => {
    // Un réglage abîmé ne doit pas se traduire par « le son ne marche plus »,
    // qui enverrait chercher la panne ailleurs.
    for (const bad of [undefined, null, 'fort', Number.NaN]) {
      expect(clampVolume(bad)).toBe(DEFAULT_VOLUME);
    }
  });
});

describe('lecture', () => {
  it('ne lance rien quand aucun son n est choisi', async () => {
    await expect(playNamed(NO_SOUND, 0.5)).resolves.toBeUndefined();
  });

  it('ne lève pas sur un son inconnu', async () => {
    await expect(playNamed('SonQuiNExistePas', 0.5, ['/dossier/absent'])).resolves.toBeUndefined();
  });

  it('ne lève pas sur un fichier inexistant', () => {
    expect(() => playFile('/dossier/absent/rien.aiff', 0.5)).not.toThrow();
  });
});

describe('libellés du pied', () => {
  it('disent l état courant plutôt qu une invitation vague', () => {
    expect(soundRowLabel('waiting', 'Ping')).toBe("Son t'attend : Ping");
    expect(soundRowLabel('done', NO_SOUND)).toBe('Son terminé : aucun');
    expect(volumeRowLabel(0.5)).toBe('Volume : 50 %');
    expect(volumeRowLabel(0)).toBe('Volume : 0 %');
  });
});

describe('FooterTree — la vue épinglée en bas', () => {
  const footer = (): FooterTree => {
    const f = new FooterTree();
    f.setSound({ waiting: 'Ping', done: 'Glass', volume: 0.4 });
    return f;
  };

  it('expose les trois réglages, et rien d autre — la consommation a sa propre vue', () => {
    expect(footer().getChildren().map((n) => n.kind)).toEqual(['sound', 'sound', 'volume']);
  });

  it('rend chaque ligne cliquable, vers sa propre commande', () => {
    const f = footer();
    expect(f.getChildren().map((n) => f.getTreeItem(n).command?.command)).toEqual([
      'kohVibe.chooseSound',
      'kohVibe.chooseSound',
      'kohVibe.chooseVolume',
    ]);
  });

  it('dit à la commande de quel événement il s agit', () => {
    const f = footer();
    const [waiting, done] = f.getChildren();
    expect(f.getTreeItem(waiting!).command?.arguments).toEqual(['waiting']);
    expect(f.getTreeItem(done!).command?.arguments).toEqual(['done']);
  });

  it('donne une couleur explicite à chaque pastille, comme partout ailleurs', () => {
    const f = footer();
    for (const node of f.getChildren()) {
      const icon = f.getTreeItem(node).iconPath as { color?: { id: string } };
      expect(icon.color?.id).toBeTruthy();
    }
  });

  it('n a aucun enfant : c est une liste, pas un arbre', () => {
    const f = footer();
    for (const node of f.getChildren()) expect(f.getChildren(node)).toEqual([]);
  });

  it('ne signale rien quand rien n a changé', () => {
    // Même règle que l arbre des sessions : le rendu tourne toutes les deux
    // secondes, et signaler à vide escamote l infobulle sous la souris.
    const f = new FooterTree();
    f.setSound({ waiting: 'Ping', done: '', volume: 0.5 });
    let heard = 0;
    f.onDidChangeTreeData(() => {
      heard += 1;
    });
    for (let i = 0; i < 5; i++) f.setSound({ waiting: 'Ping', done: '', volume: 0.5 });
    expect(heard).toBe(0);
    f.setSound({ waiting: 'Glass', done: '', volume: 0.5 });
    expect(heard).toBe(1);
  });
});
