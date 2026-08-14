import { describe, expect, it } from 'vitest';
import {
  assign, createGroup, deleteGroup, emptyGroups, groupIdOf, parseGroups,
  pruneAssignments, renameGroup, reorder, serializeGroups, sessionOrderOf, setGroupColor,
  setGroupSound, setSessionOrder, setSessionSound, soundFor, unassign,
} from '../src/groups/model';
import type { GroupsState } from '../src/groups/model';

describe('parseGroups', () => {
  it('rend un état vide sur une donnée illisible', () => {
    expect(parseGroups('pas du json')).toEqual(emptyGroups());
    expect(parseGroups('null')).toEqual(emptyGroups());
    expect(parseGroups('[]')).toEqual(emptyGroups());
  });

  it('préserve les champs inconnus du fichier', () => {
    const s = parseGroups(JSON.stringify({ version: 1, groups: [], assignments: {}, futur: { a: 1 } }));
    expect(s.unknown).toEqual({ futur: { a: 1 } });
  });

  it('écarte un dossier sans identifiant ou sans nom, garde les autres', () => {
    const s = parseGroups(JSON.stringify({
      groups: [{ id: 'g1', name: 'bon', order: 0 }, { id: 'g2' }, { name: 'sans id' }],
      assignments: {},
    }));
    expect(s.groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('écarte une affectation qui ne pointe sur aucun dossier', () => {
    const s = parseGroups(JSON.stringify({
      groups: [{ id: 'g1', name: 'bon', order: 0 }],
      assignments: { s1: 'g1', s2: 'disparu' },
    }));
    expect(s.assignments).toEqual({ s1: 'g1' });
  });

  it('déduplique les dossiers de même identifiant, garde la première occurrence', () => {
    const s = parseGroups(JSON.stringify({
      groups: [
        { id: 'g1', name: 'premier', order: 0 },
        { id: 'g1', name: 'second', order: 1 },
      ],
      assignments: {},
    }));
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]?.name).toBe('premier');
  });

  it('ignore un champ groups qui n est pas un tableau', () => {
    const s = parseGroups(JSON.stringify({ groups: 'pas un tableau', assignments: {} }));
    expect(s.groups).toEqual([]);
  });

  it('ignore un champ assignments qui est une chaîne', () => {
    const s = parseGroups(JSON.stringify({
      groups: [{ id: 'g1', name: 'bon', order: 0 }],
      assignments: 'pas un objet',
    }));
    expect(s.assignments).toEqual({});
  });

  it('garde une affectation dont la clé de session est vide', () => {
    const s = parseGroups(JSON.stringify({
      groups: [{ id: 'g1', name: 'bon', order: 0 }],
      assignments: { '': 'g1' },
    }));
    expect(s.assignments).toEqual({ '': 'g1' });
  });
});

describe('createGroup', () => {
  it('ajoute le dossier en dernier', () => {
    const s = createGroup(createGroup(emptyGroups(), 'un', () => 'a'), 'deux', () => 'b');
    expect(s.groups.map((g) => [g.name, g.order])).toEqual([['un', 0], ['deux', 1]]);
  });

  it('refuse un nom vide ou fait d espaces', () => {
    expect(() => createGroup(emptyGroups(), '   ', () => 'a')).toThrow();
  });

  it('coupe les espaces autour du nom', () => {
    expect(createGroup(emptyGroups(), '  Vetibble  ', () => 'a').groups[0]?.name).toBe('Vetibble');
  });

  it('accepte deux dossiers de même nom, avec des identifiants distincts', () => {
    let n = 0;
    const s = createGroup(createGroup(emptyGroups(), 'même', () => `g${++n}`), 'même', () => `g${++n}`);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[0]?.id).not.toBe(s.groups[1]?.id);
  });
});

describe('assign / unassign', () => {
  const base = createGroup(emptyGroups(), 'dossier', () => 'g1');

  it('affecte une session à un dossier', () => {
    expect(groupIdOf(assign(base, 's1', 'g1'), 's1')).toBe('g1');
  });

  it('ignore une affectation vers un dossier inexistant', () => {
    expect(groupIdOf(assign(base, 's1', 'fantôme'), 's1')).toBeUndefined();
  });

  it('déplacer remplace, ça ne cumule pas', () => {
    const deux = createGroup(base, 'autre', () => 'g2');
    const s = assign(assign(deux, 's1', 'g1'), 's1', 'g2');
    expect(groupIdOf(s, 's1')).toBe('g2');
    expect(Object.keys(s.assignments)).toHaveLength(1);
  });

  it('retirer rend la session à « sans dossier »', () => {
    expect(groupIdOf(unassign(assign(base, 's1', 'g1'), 's1'), 's1')).toBeUndefined();
  });
});

describe('deleteGroup', () => {
  it('rend ses sessions à « sans dossier » plutôt que de les perdre', () => {
    const s = deleteGroup(assign(createGroup(emptyGroups(), 'd', () => 'g1'), 's1', 'g1'), 'g1');
    expect(s.groups).toHaveLength(0);
    expect(s.assignments).toEqual({});
  });

  it('renumérote l ordre des dossiers restants sans trou', () => {
    let n = 0;
    let s = emptyGroups();
    for (const nom of ['a', 'b', 'c']) s = createGroup(s, nom, () => `g${++n}`);
    expect(deleteGroup(s, 'g2').groups.map((g) => g.order)).toEqual([0, 1]);
  });
});

describe('renameGroup', () => {
  it('renomme sans toucher aux affectations', () => {
    const s = renameGroup(assign(createGroup(emptyGroups(), 'vieux', () => 'g1'), 's1', 'g1'), 'g1', 'neuf');
    expect(s.groups[0]?.name).toBe('neuf');
    expect(groupIdOf(s, 's1')).toBe('g1');
  });

  it('refuse un nom vide', () => {
    expect(() => renameGroup(createGroup(emptyGroups(), 'x', () => 'g1'), 'g1', ' ')).toThrow();
  });
});

describe('serializeGroups', () => {
  it('un champ inconnu traverse un aller-retour complet intact', () => {
    const original = parseGroups(JSON.stringify({
      groups: [{ id: 'g1', name: 'dossier', order: 0 }],
      assignments: { s1: 'g1' },
      futur: { a: 1 },
    }));
    expect(parseGroups(serializeGroups(original))).toEqual(original);
  });
});

describe('pruneAssignments', () => {
  it('retire les affectations des sessions disparues, garde les vivantes', () => {
    let s = createGroup(emptyGroups(), 'd', () => 'g1');
    s = assign(assign(s, 'vivante', 'g1'), 'morte', 'g1');
    const out = pruneAssignments(s, new Set(['vivante']));
    expect(Object.keys(out.assignments)).toEqual(['vivante']);
  });

  it('ne touche jamais aux dossiers eux-mêmes, même vidés', () => {
    const s = pruneAssignments(assign(createGroup(emptyGroups(), 'd', () => 'g1'), 's1', 'g1'), new Set());
    expect(s.groups).toHaveLength(1);
  });

  it('rend le même objet quand il n y a rien à retirer', () => {
    const s = assign(createGroup(emptyGroups(), 'd', () => 'g1'), 's1', 'g1');
    expect(pruneAssignments(s, new Set(['s1']))).toBe(s);
  });
});

describe('setGroupColor', () => {
  const state = (): GroupsState =>
    parseGroups(JSON.stringify({ version: 1, groups: [{ id: 'g-1', name: 'Un', order: 0 }], assignments: {} }));

  it('pose la couleur sur le bon dossier, et sur lui seul', () => {
    const two = parseGroups(
      JSON.stringify({
        version: 1,
        groups: [
          { id: 'g-1', name: 'Un', order: 0 },
          { id: 'g-2', name: 'Deux', order: 1 },
        ],
        assignments: {},
      }),
    );
    const after = setGroupColor(two, 'g-2', 'red');
    expect(after.groups.map((g) => g.color)).toEqual([undefined, 'red']);
  });

  it('remplace une couleur déjà posée', () => {
    expect(setGroupColor(setGroupColor(state(), 'g-1', 'blue'), 'g-1', 'green').groups[0]?.color).toBe('green');
  });

  it('retire la clé plutôt que d\'écrire une couleur vide', () => {
    const cleared = setGroupColor(setGroupColor(state(), 'g-1', 'blue'), 'g-1', undefined);
    expect(cleared.groups[0]).not.toHaveProperty('color');
    expect(JSON.parse(serializeGroups(cleared)).groups[0]).not.toHaveProperty('color');
  });

  it('ignore un dossier qui n\'existe pas', () => {
    expect(setGroupColor(state(), 'g-inconnu', 'red').groups[0]?.color).toBeUndefined();
  });

  it('fait le tour du fichier : une couleur écrite se relit', () => {
    const written = serializeGroups(setGroupColor(state(), 'g-1', 'purple'));
    expect(parseGroups(written).groups[0]?.color).toBe('purple');
  });

  it('conserve une couleur qu\'on ne connaît pas — l\'autre éditeur peut être plus récent', () => {
    const raw = JSON.stringify({
      version: 1,
      groups: [{ id: 'g-1', name: 'Un', order: 0, color: 'turquoise' }],
      assignments: {},
    });
    expect(parseGroups(raw).groups[0]?.color).toBe('turquoise');
    expect(JSON.parse(serializeGroups(parseGroups(raw))).groups[0].color).toBe('turquoise');
  });
});

describe('reorder', () => {
  it('place les déplacées devant la cible', () => {
    expect(reorder(['a', 'b', 'c'], ['c'], 'b')).toEqual(['a', 'c', 'b']);
  });

  it('place à la fin quand il n y a pas de cible', () => {
    expect(reorder(['a', 'b'], ['a'], undefined)).toEqual(['b', 'a']);
  });

  it('ne déplace rien quand on dépose une session sur elle-même', () => {
    expect(reorder(['a', 'b', 'c'], ['b'], 'b')).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], ['a'], 'a')).toEqual(['a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c'], ['c'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('descend correctement une session vers le bas de sa propre liste', () => {
    // Le cas que le retrait préalable rendrait impossible : sans lui, « a »
    // serait inséré avant lui-même et rien ne bougerait.
    expect(reorder(['a', 'b', 'c'], ['a'], 'c')).toEqual(['b', 'a', 'c']);
  });

  it('accueille une session venue d un autre dossier', () => {
    expect(reorder(['a', 'b'], ['x'], 'b')).toEqual(['a', 'x', 'b']);
  });

  it('garde les déplacées ensemble et dans leur ordre', () => {
    expect(reorder(['a', 'b', 'c', 'd'], ['d', 'a'], 'c')).toEqual(['b', 'd', 'a', 'c']);
  });

  it('place à la fin quand la cible est inconnue, plutôt que de deviner', () => {
    expect(reorder(['a', 'b'], ['x'], 'inexistante')).toEqual(['a', 'b', 'x']);
  });
});

describe('sessionOrder', () => {
  const state = (): GroupsState => parseGroups(JSON.stringify({ version: 1, groups: [], assignments: {} }));

  it('sépare l ordre d un dossier de celui de « Sans dossier »', () => {
    let s = setSessionOrder(state(), 'g-1', ['a', 'b']);
    s = setSessionOrder(s, undefined, ['x']);
    expect(sessionOrderOf(s, 'g-1')).toEqual(['a', 'b']);
    expect(sessionOrderOf(s, undefined)).toEqual(['x']);
  });

  it('retire l entrée plutôt que d écrire une liste vide', () => {
    const cleared = setSessionOrder(setSessionOrder(state(), 'g-1', ['a']), 'g-1', []);
    expect(JSON.parse(serializeGroups(cleared)).sessionOrder).toEqual({});
  });

  it('fait le tour du fichier', () => {
    const written = serializeGroups(setSessionOrder(state(), 'g-1', ['a', 'b']));
    expect(sessionOrderOf(parseGroups(written), 'g-1')).toEqual(['a', 'b']);
  });

  it('ignore une entrée mal formée sans faire tomber toute la lecture', () => {
    const raw = JSON.stringify({
      version: 1,
      groups: [{ id: 'g-1', name: 'Un', order: 0 }],
      assignments: {},
      sessionOrder: { 'g-1': ['a', 42, '', 'b'], 'g-2': 'pas un tableau' },
    });
    const s = parseGroups(raw);
    expect(sessionOrderOf(s, 'g-1')).toEqual(['a', 'b']);
    expect(sessionOrderOf(s, 'g-2')).toEqual([]);
    expect(s.groups).toHaveLength(1);
  });

  it('oublie l ordre d un dossier supprimé', () => {
    let s = parseGroups(JSON.stringify({ version: 1, groups: [{ id: 'g-1', name: 'Un', order: 0 }], assignments: {} }));
    s = setSessionOrder(s, 'g-1', ['a', 'b']);
    expect(sessionOrderOf(deleteGroup(s, 'g-1'), 'g-1')).toEqual([]);
  });

  it('retire des ordres les sessions qui n existent plus', () => {
    let s = setSessionOrder(state(), 'g-1', ['vivante', 'morte']);
    s = setSessionOrder(s, undefined, ['morte']);
    const pruned = pruneAssignments(s, new Set(['vivante']));
    expect(sessionOrderOf(pruned, 'g-1')).toEqual(['vivante']);
    expect(sessionOrderOf(pruned, undefined)).toEqual([]);
  });

  it('rend le même objet quand il n y a rien à retirer', () => {
    const s = setSessionOrder(state(), 'g-1', ['vivante']);
    expect(pruneAssignments(s, new Set(['vivante']))).toBe(s);
  });
});

describe('soundFor — trois niveaux de priorité', () => {
  const state = (): GroupsState =>
    parseGroups(
      JSON.stringify({
        version: 1,
        groups: [{ id: 'g1', name: 'Dossier', order: 0, sound: 'SonDuDossier' }],
        assignments: { s1: 'g1' },
        sessionSounds: { s1: 'SonDeLaConversation' },
      }),
    );

  it('la conversation l emporte sur son dossier', () => {
    expect(soundFor(state(), 's1', 'SonGlobal')).toBe('SonDeLaConversation');
  });

  it('le dossier l emporte sur le réglage global', () => {
    expect(soundFor(setSessionSound(state(), 's1', undefined), 's1', 'SonGlobal')).toBe('SonDuDossier');
  });

  it('le réglage global sert de dernier recours', () => {
    let s = setSessionSound(state(), 's1', undefined);
    s = setGroupSound(s, 'g1', undefined);
    expect(soundFor(s, 's1', 'SonGlobal')).toBe('SonGlobal');
  });

  it('une session hors dossier retombe directement sur le global', () => {
    expect(soundFor(state(), 'inconnue', 'SonGlobal')).toBe('SonGlobal');
  });

  it('un silence choisi ne perce PAS vers le niveau au-dessus', () => {
    // « Aucun » est un choix explicite : il doit taire la conversation même si
    // son dossier a un son. Sans ça, on ne pourrait jamais faire taire une seule
    // conversation d un dossier sonore.
    expect(soundFor(setSessionSound(state(), 's1', ''), 's1', 'SonGlobal')).toBe('');
    const muet = setGroupSound(setSessionSound(state(), 's1', undefined), 'g1', '');
    expect(soundFor(muet, 's1', 'SonGlobal')).toBe('');
  });

  it('fait le tour du fichier', () => {
    const relu = parseGroups(serializeGroups(state()));
    expect(soundFor(relu, 's1', 'SonGlobal')).toBe('SonDeLaConversation');
    expect(relu.groups[0]?.sound).toBe('SonDuDossier');
  });

  it('oublie le son d une session qui n existe plus', () => {
    const pruned = pruneAssignments(state(), new Set());
    expect(pruned.sessionSounds).toEqual({});
  });
});
