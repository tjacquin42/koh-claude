import { describe, expect, it, vi } from 'vitest';
import { SessionsTree, groupIdOfNode } from '../src/ui/tree';
import type { TreeNode } from '../src/ui/tree';
import type { Session } from '../src/events/types';
import type { GroupsState } from '../src/groups/model';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'idle',
  toolCount: 0,
  lastEventAt: 0,
  ...overrides,
});

const groups = (state: Partial<GroupsState>): GroupsState => ({
  groups: [],
  assignments: {},
  sessionOrder: {},
  unknown: {},
  ...state,
});

// onDrop est obligatoire au constructeur : ces tests portent sur l'affichage,
// pas sur le glisser-déposer, donc un bouchon sans effet partagé suffit ici.
const noopOnDrop = async (): Promise<void> => undefined;

// Les tests affirment la liste des libellés effectivement rendus (via
// getTreeItem), pas un simple compte de nœuds : un compte ne dit rien de
// l'ordre ni du contenu, deux propriétés que ces règles portent explicitement.
const labelsOf = async (tree: SessionsTree, node?: TreeNode): Promise<string[]> => {
  const children = await tree.getChildren(node);
  return children.map((child) => String(tree.getTreeItem(child).label));
};

// I5 : l'état « hooks installés » ne doit être recalculé que lorsqu'il est
// réellement consulté — c'est-à-dire quand l'arbre s'apprête à afficher son
// nœud vide, donc uniquement quand il n'y a aucune session à montrer. Deux
// propriétés vérifiées : le coût n'est payé que dans ce cas, et le symptôme
// (l'arbre affiche « non installés » alors que des sessions existent déjà)
// disparaît par construction puisque la vérification n'est même pas
// consultée quand des sessions sont là.
describe('SessionsTree — hooksInstalled recalculé à la demande (I5)', () => {
  it("n'interroge pas l'état des hooks quand des sessions sont à afficher, même s'ils sont en réalité désinstallés", async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(false);
    const tree = new SessionsTree(checkHooksInstalled, noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')]]));

    const children = await tree.getChildren();

    expect(checkHooksInstalled).not.toHaveBeenCalled();
    expect(children).toEqual([{ kind: 'group', group: undefined, sessions: [session('s1')] }]);
  });

  it("interroge l'état des hooks seulement quand il n'y a aucune session, et affiche le nœud d'installation s'ils manquent", async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(false);
    const tree = new SessionsTree(checkHooksInstalled, noopOnDrop);

    const children = await tree.getChildren();

    expect(checkHooksInstalled).toHaveBeenCalledTimes(1);
    expect(children).toEqual([
      { kind: 'empty', message: 'Hooks non installés — cliquez pour les installer', action: 'install' },
    ]);
  });

  it("un rendu sans session reflète une installation faite entre-temps, sans rechargement de fenêtre", async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const tree = new SessionsTree(checkHooksInstalled, noopOnDrop);

    const before = await tree.getChildren();
    expect(before).toEqual([
      { kind: 'empty', message: 'Hooks non installés — cliquez pour les installer', action: 'install' },
    ]);

    const after = await tree.getChildren();

    expect(after).toEqual([{ kind: 'empty', message: 'Aucune session Claude Code active' }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(2);
  });

  it('ne consulte plus jamais les hooks une fois que des sessions apparaissent (le symptôme I5 disparaît par construction)', async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(false);
    const tree = new SessionsTree(checkHooksInstalled, noopOnDrop);

    await tree.getChildren(); // aucune session : interroge, affiche « non installés »
    tree.setSessions(new Map([['s1', session('s1')]]));
    const children = await tree.getChildren();

    expect(children).toEqual([{ kind: 'group', group: undefined, sessions: [session('s1')] }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(1); // pas un second appel
  });
});

describe('SessionsTree — deux niveaux : dossiers puis sessions', () => {
  it('range les sessions sous leur dossier, dans l ordre des dossiers', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(
      new Map([
        ['s1', session('s1', { project: 'alpha' })],
        ['s2', session('s2', { project: 'beta' })],
      ]),
    );
    tree.setGroups(
      groups({
        groups: [
          { id: 'g-perso', name: 'Perso', order: 0 },
          { id: 'g-taf', name: 'Taf', order: 1 },
        ],
        assignments: { s1: 'g-taf', s2: 'g-perso' },
      }),
    );

    expect(await labelsOf(tree)).toEqual(['Perso', '', 'Taf']);

    const [persoNode, , tafNode] = await tree.getChildren();
    expect(await labelsOf(tree, persoNode)).toEqual(['beta']);
    expect(await labelsOf(tree, tafNode)).toEqual(['alpha']);
  });

  it('« Sans dossier » vient toujours en dernier', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(
      new Map([
        ['s1', session('s1', { project: 'alpha' })],
        ['s2', session('s2', { project: 'beta' })],
      ]),
    );
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier unique', order: 0 }],
        assignments: { s1: 'g1' }, // s2 reste non rangée
      }),
    );

    expect(await labelsOf(tree)).toEqual(['Dossier unique', '', 'Sans dossier']);
  });

  it('« Sans dossier » disparaît quand toutes les sessions sont rangées', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')]]));
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1' },
      }),
    );

    expect(await labelsOf(tree)).toEqual(['Dossier']);
  });

  it('un dossier vide reste visible, pour pouvoir y déposer', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')]])); // non rangée
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier vide', order: 0 }],
      }),
    );

    expect(await labelsOf(tree)).toEqual(['Dossier vide', '', 'Sans dossier']);

    const [emptyGroupNode] = await tree.getChildren();
    expect(await labelsOf(tree, emptyGroupNode)).toEqual([]);
  });

  it('trie les sessions d un dossier par statut puis par récence, comme la liste globale', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(
      new Map([
        ['s1', session('s1', { project: 'idle-old', status: 'idle', lastEventAt: 100 })],
        ['s2', session('s2', { project: 'waiting', status: 'waiting', lastEventAt: 50 })],
        ['s3', session('s3', { project: 'termine', status: 'done_unseen', lastEventAt: 50 })],
        ['s4', session('s4', { project: 'idle-new', status: 'idle', lastEventAt: 200 })],
      ]),
    );
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1', s2: 'g1', s3: 'g1', s4: 'g1' },
      }),
    );

    const [groupNode] = await tree.getChildren();
    expect(await labelsOf(tree, groupNode)).toEqual(['waiting', 'termine', 'idle-new', 'idle-old']);
  });

  it('donne un contextValue distinct à un vrai dossier et à « Sans dossier »', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')], ['s2', session('s2')]]));
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1' }, // s2 reste non rangée
      }),
    );

    const [groupNode, , unfiledNode] = await tree.getChildren();
    expect(tree.getTreeItem(groupNode).contextValue).toBe('group');
    expect(tree.getTreeItem(unfiledNode).contextValue).toBe('unfiled');
  });

  it('l état vide global est inchangé quand il n y a aucune session', async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(true);
    const tree = new SessionsTree(checkHooksInstalled, noopOnDrop);
    tree.setGroups(groups({ groups: [{ id: 'g1', name: 'Dossier', order: 0 }] }));

    const children = await tree.getChildren();

    expect(children).toEqual([{ kind: 'empty', message: 'Aucune session Claude Code active' }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(1);
  });
});

// groupIdOfNode : ce que VSCode passe à kohClaude.renameGroup/deleteGroup
// depuis le menu contextuel (view/item/context) est l'élément de l'arbre
// tel quel, jamais un TreeItem — donc n'importe quoi du point de vue du
// typage TypeScript. Ces tests couvrent la validation sans cast, comme
// handleDrop dans test/tree-dnd.test.ts.
describe('groupIdOfNode — résout un identifiant de dossier sans jamais caster', () => {
  it("retrouve l'identifiant d'un nœud de dossier nommé", () => {
    const node: TreeNode = { kind: 'group', group: { id: 'g1', name: 'Perso', order: 0 }, sessions: [] };

    expect(groupIdOfNode(node)).toBe('g1');
  });

  it('renvoie undefined pour « Sans dossier » (group: undefined)', () => {
    const node: TreeNode = { kind: 'group', group: undefined, sessions: [] };

    expect(groupIdOfNode(node)).toBeUndefined();
  });

  it('renvoie undefined pour un nœud de session', () => {
    const node: TreeNode = {
      kind: 'session',
      session: {
        id: 's1',
        cwd: '/Users/dev/projet',
        project: 'projet',
        origin: 'vscode',
        status: 'idle',
        toolCount: 0,
        lastEventAt: 0,
      },
    };

    expect(groupIdOfNode(node)).toBeUndefined();
  });

  it('renvoie undefined pour un nœud vide', () => {
    expect(groupIdOfNode({ kind: 'empty', message: 'Aucune session Claude Code active' })).toBeUndefined();
  });

  it.each([undefined, null, 'g1', 42, []])('renvoie undefined pour une valeur non objet : %p', (value) => {
    expect(groupIdOfNode(value)).toBeUndefined();
  });

  it("renvoie undefined quand group.id n'est pas une chaîne", () => {
    expect(groupIdOfNode({ kind: 'group', group: { id: 42, name: 'x', order: 0 } })).toBeUndefined();
  });

  // Preuve par mutation (revue Task 9, tour 2) : sans ce test, retirer
  // `candidate.kind !== 'group' ||` laisse les autres tests de ce bloc verts
  // quand même — aucun d'eux ne combine un `kind` différent de `'group'` avec
  // un `group.id` par ailleurs valide, donc rien ne dépendait réellement de
  // cette moitié de la garde. Un objet malformé (aucune forme réelle de
  // TreeNode ne porte à la fois `kind: 'session'` et un champ `group`) suffit
  // à le prouver : sans la vérification du `kind`, la seule condition
  // restante (`group !== undefined`) laisserait passer 'g1'.
  it('ignore un group.id valide porté par un nœud dont le kind n est pas "group"', () => {
    expect(groupIdOfNode({ kind: 'session', group: { id: 'g1', name: 'x', order: 0 } })).toBeUndefined();
  });
});

describe('SessionsTree — espace et couleur des dossiers', () => {
  const withGroups = (list: Array<{ id: string; name: string; order: number; color?: string }>): SessionsTree => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')]]));
    tree.setGroups(groups({ groups: list, assignments: { s1: list[0]?.id ?? 'g-1' } }));
    return tree;
  };

  it('sépare les dossiers par une ligne vide, jamais avant le premier ni après le dernier', async () => {
    const tree = withGroups([
      { id: 'g-1', name: 'Un', order: 0 },
      { id: 'g-2', name: 'Deux', order: 1 },
      { id: 'g-3', name: 'Trois', order: 2 },
    ]);
    expect(await labelsOf(tree)).toEqual(['Un', '', 'Deux', '', 'Trois']);
  });

  it('n\'ajoute aucune ligne quand il n\'y a qu\'un seul dossier', async () => {
    const tree = withGroups([{ id: 'g-1', name: 'Seul', order: 0 }]);
    expect(await labelsOf(tree)).toEqual(['Seul']);
  });

  it('donne des identités distinctes aux séparateurs — deux nœuds identiques se marcheraient dessus', async () => {
    const tree = withGroups([
      { id: 'g-1', name: 'Un', order: 0 },
      { id: 'g-2', name: 'Deux', order: 1 },
      { id: 'g-3', name: 'Trois', order: 2 },
    ]);
    const spacers = (await tree.getChildren()).filter((n) => n.kind === 'spacer');
    expect(spacers).toHaveLength(2);
    expect(new Set(spacers.map((n) => (n.kind === 'spacer' ? n.after : ''))).size).toBe(2);
  });

  it('ne rend le séparateur ni cliquable, ni ciblable par un menu', async () => {
    const tree = withGroups([
      { id: 'g-1', name: 'Un', order: 0 },
      { id: 'g-2', name: 'Deux', order: 1 },
    ]);
    const [, spacer] = await tree.getChildren();
    const item = tree.getTreeItem(spacer);
    expect(item.command).toBeUndefined();
    expect(item.contextValue).toBeUndefined();
    expect(await tree.getChildren(spacer)).toEqual([]);
  });

  it('colore l\'icône du dossier avec la couleur choisie', async () => {
    const tree = withGroups([{ id: 'g-1', name: 'Un', order: 0, color: 'green' }]);
    const [node] = await tree.getChildren();
    const icon = tree.getTreeItem(node).iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe('folder');
    expect(icon.color?.id).toBe('charts.green');
  });

  it('affiche sans couleur un dossier sans choix, ou dont la couleur nous est inconnue', async () => {
    for (const color of [undefined, 'turquoise']) {
      const tree = withGroups([{ id: 'g-1', name: 'Un', order: 0, color }]);
      const [node] = await tree.getChildren();
      const icon = tree.getTreeItem(node).iconPath as { id: string; color?: { id: string } };
      expect(icon.id).toBe('folder');
      expect(icon.color).toBeUndefined();
    }
  });

  it('ne colore pas « Sans dossier », qui ne porte aucun choix de l\'utilisateur', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(new Map([['s1', session('s1')]]));
    tree.setGroups(groups({ groups: [] }));
    const [node] = await tree.getChildren();
    const icon = tree.getTreeItem(node).iconPath as { id: string; color?: { id: string } };
    expect(icon.color).toBeUndefined();
  });
});

describe('SessionsTree — ordre choisi à la main', () => {
  const three = (): Map<string, Session> =>
    new Map([
      ['s1', session('s1', { project: 'un', status: 'idle', lastEventAt: 30 })],
      ['s2', session('s2', { project: 'deux', status: 'idle', lastEventAt: 20 })],
      ['s3', session('s3', { project: 'trois', status: 'idle', lastEventAt: 10 })],
    ]);

  const treeWith = (sessionOrder: Record<string, readonly string[]>): SessionsTree => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(three());
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1', s2: 'g1', s3: 'g1' },
        sessionOrder,
      }),
    );
    return tree;
  };

  it('sans ordre choisi, garde le tri du tableau de bord', async () => {
    const [group] = await treeWith({}).getChildren();
    expect(await labelsOf(treeWith({}), group)).toEqual(['un', 'deux', 'trois']);
  });

  it('respecte l ordre choisi, quel que soit le tri par défaut', async () => {
    const tree = treeWith({ g1: ['s3', 's1', 's2'] });
    const [group] = await tree.getChildren();
    expect(await labelsOf(tree, group)).toEqual(['trois', 'un', 'deux']);
  });

  it('ne bouge pas quand un statut change — c est tout l intérêt d un ordre fixe', async () => {
    const tree = treeWith({ g1: ['s3', 's1', 's2'] });
    const bumped = three();
    // s2 passe en tête du tri par défaut (elle t attend) : l ordre choisi tient.
    bumped.set('s2', session('s2', { project: 'deux', status: 'waiting', lastEventAt: 99 }));
    tree.setSessions(bumped);
    const [group] = await tree.getChildren();
    expect(await labelsOf(tree, group)).toEqual(['trois', 'un', 'deux']);
  });

  it('place à la fin une session que l ordre ne nomme pas, sans bousculer les autres', async () => {
    const tree = treeWith({ g1: ['s3', 's1'] });
    const [group] = await tree.getChildren();
    expect(await labelsOf(tree, group)).toEqual(['trois', 'un', 'deux']);
  });

  it('ignore un identifiant qui ne correspond à aucune session vivante', async () => {
    const tree = treeWith({ g1: ['fantome', 's2'] });
    const [group] = await tree.getChildren();
    expect(await labelsOf(tree, group)).toEqual(['deux', 'un', 'trois']);
  });

  it('ordonne aussi « Sans dossier »', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(three());
    tree.setGroups(groups({ sessionOrder: { '': ['s3', 's2', 's1'] } }));
    const [unfiled] = await tree.getChildren();
    expect(await labelsOf(tree, unfiled)).toEqual(['trois', 'deux', 'un']);
  });

  it('ne mélange pas l ordre d un dossier avec celui de « Sans dossier »', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    tree.setSessions(three());
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1' },
        sessionOrder: { g1: ['s1'], '': ['s3', 's2'] },
      }),
    );
    const [group, , unfiled] = await tree.getChildren();
    expect(await labelsOf(tree, group)).toEqual(['un']);
    expect(await labelsOf(tree, unfiled)).toEqual(['trois', 'deux']);
  });
});
