import { describe, expect, it, vi } from 'vitest';
import { SessionsTree } from '../src/ui/tree';
import type { Session } from '../src/events/types';

const session = (id: string): Session => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'idle',
  toolCount: 0,
  lastEventAt: 0,
});

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
    expect(children).toEqual([{ kind: 'project', project: 'projet', sessions: [session('s1')] }]);
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

    expect(children).toEqual([{ kind: 'project', project: 'projet', sessions: [session('s1')] }]);
    expect(checkHooksInstalled).toHaveBeenCalledTimes(1); // pas un second appel
  });
});
