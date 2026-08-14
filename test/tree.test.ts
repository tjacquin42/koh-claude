import { describe, expect, it, vi } from 'vitest';
import { SessionsTree } from '../src/ui/tree';
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
  unknown: {},
  ...state,
});

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
    const tree = new SessionsTree(checkHooksInstalled);
    tree.setSessions(new Map([['s1', session('s1')]]));

    const children = await tree.getChildren();

    expect(checkHooksInstalled).not.toHaveBeenCalled();
    expect(children).toEqual([{ kind: 'group', group: undefined, sessions: [session('s1')] }]);
  });

  it("interroge l'état des hooks seulement quand il n'y a aucune session, et affiche le nœud d'installation s'ils manquent", async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(false);
    const tree = new SessionsTree(checkHooksInstalled);

    const children = await tree.getChildren();

    expect(checkHooksInstalled).toHaveBeenCalledTimes(1);
    expect(children).toEqual([
      { kind: 'empty', message: 'Hooks non installés — cliquez pour les installer', action: 'install' },
    ]);
  });

  it("un rendu sans session reflète une installation faite entre-temps, sans rechargement de fenêtre", async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const tree = new SessionsTree(checkHooksInstalled);

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
    const tree = new SessionsTree(checkHooksInstalled);

    await tree.getChildren(); // aucune session : interroge, affiche « non installés »
    tree.setSessions(new Map([['s1', session('s1')]]));
    const children = await tree.getChildren();

    expect(children).toEqual([{ kind: 'group', group: undefined, sessions: [session('s1')] }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(1); // pas un second appel
  });
});

describe('SessionsTree — deux niveaux : dossiers puis sessions', () => {
  it('range les sessions sous leur dossier, dans l ordre des dossiers', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
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

    expect(await labelsOf(tree)).toEqual(['Perso', 'Taf']);

    const [persoNode, tafNode] = await tree.getChildren();
    expect(await labelsOf(tree, persoNode)).toEqual(['beta']);
    expect(await labelsOf(tree, tafNode)).toEqual(['alpha']);
  });

  it('« Sans dossier » vient toujours en dernier', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
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

    expect(await labelsOf(tree)).toEqual(['Dossier unique', 'Sans dossier']);
  });

  it('« Sans dossier » disparaît quand toutes les sessions sont rangées', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
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
    const tree = new SessionsTree(() => Promise.resolve(true));
    tree.setSessions(new Map([['s1', session('s1')]])); // non rangée
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier vide', order: 0 }],
      }),
    );

    expect(await labelsOf(tree)).toEqual(['Dossier vide', 'Sans dossier']);

    const [emptyGroupNode] = await tree.getChildren();
    expect(await labelsOf(tree, emptyGroupNode)).toEqual([]);
  });

  it('trie les sessions d un dossier par statut puis par récence, comme la liste globale', async () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
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
    const tree = new SessionsTree(() => Promise.resolve(true));
    tree.setSessions(new Map([['s1', session('s1')], ['s2', session('s2')]]));
    tree.setGroups(
      groups({
        groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
        assignments: { s1: 'g1' }, // s2 reste non rangée
      }),
    );

    const [groupNode, unfiledNode] = await tree.getChildren();
    expect(tree.getTreeItem(groupNode).contextValue).toBe('group');
    expect(tree.getTreeItem(unfiledNode).contextValue).toBe('unfiled');
  });

  it('l état vide global est inchangé quand il n y a aucune session', async () => {
    const checkHooksInstalled = vi.fn().mockResolvedValue(true);
    const tree = new SessionsTree(checkHooksInstalled);
    tree.setGroups(groups({ groups: [{ id: 'g1', name: 'Dossier', order: 0 }] }));

    const children = await tree.getChildren();

    expect(children).toEqual([{ kind: 'empty', message: 'Aucune session Claude Code active' }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(1);
  });
});
