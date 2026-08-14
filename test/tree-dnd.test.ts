import { describe, expect, it, vi } from 'vitest';
import { DataTransfer, DataTransferItem } from 'vscode';
import { SessionsTree } from '../src/ui/tree';
import type { TreeNode } from '../src/ui/tree';
import type { Session } from '../src/events/types';

// Le type MIME propre à cet arbre : c'est lui qui distingue « une donnée qui
// vient de nous » d'une donnée déposée par un autre arbre ou par l'OS. Répété
// ici en dur (plutôt qu'importé) parce que la valeur exacte fait partie du
// contrat public de la vue — un test qui l'importerait ne le vérifierait
// plus.
const MIME = 'application/vnd.code.tree.kohclaude.sessions';

const session = (id: string): Session => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'idle',
  toolCount: 0,
  lastEventAt: 0,
});

const sessionNode = (id: string): TreeNode => ({ kind: 'session', session: session(id) });
const groupNode = (id: string, name: string): TreeNode => ({
  kind: 'group',
  group: { id, name, order: 0 },
  sessions: [],
});
const unfiledNode = (): TreeNode => ({ kind: 'group', group: undefined, sessions: [] });

const dataWith = (ids: unknown): DataTransfer => {
  const data = new DataTransfer();
  data.set(MIME, new DataTransferItem(ids));
  return data;
};

describe('SessionsTree — handleDrop (la décision, pas le mécanisme VSCode)', () => {
  it('affecte une session déposée sur un dossier', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g-perso', 'Perso'), dataWith(['s1']));

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['s1'], 'g-perso');
  });

  it('affecte plusieurs sessions déposées d un coup sur un dossier', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g-taf', 'Taf'), dataWith(['s1', 's2', 's3']));

    expect(onDrop).toHaveBeenCalledWith(['s1', 's2', 's3'], 'g-taf');
  });

  it('retire l affectation quand on dépose sur « Sans dossier »', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(unfiledNode(), dataWith(['s1']));

    expect(onDrop).toHaveBeenCalledWith(['s1'], undefined);
  });

  it('ne change rien quand on dépose sur le vide de la vue (aucune cible)', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(undefined, dataWith(['s1']));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ne change rien quand la donnée déposée ne porte pas notre type MIME', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);
    const data = new DataTransfer();
    data.set('text/plain', new DataTransferItem('un texte quelconque'));

    await tree.handleDrop(groupNode('g1', 'Dossier'), data);

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ne change rien quand la valeur transportée n est pas un tableau', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g1', 'Dossier'), dataWith('s1'));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('filtre les entrées non-chaînes plutôt que de les caster, et ignore ce qui ne reste plus', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g1', 'Dossier'), dataWith(['s1', 42, null, 's2']));

    expect(onDrop).toHaveBeenCalledWith(['s1', 's2'], 'g1');
  });

  it('ne change rien quand le tableau transporté ne contient aucune chaîne exploitable', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g1', 'Dossier'), dataWith([42, null]));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("n'appelle rien quand onDrop n'a pas été fourni (comportement par défaut sans effet)", async () => {
    const tree = new SessionsTree(() => Promise.resolve(true));

    await expect(tree.handleDrop(groupNode('g1', 'Dossier'), dataWith(['s1']))).resolves.toBeUndefined();
  });
});

describe('SessionsTree — handleDrag (ce qui part dans le transfert)', () => {
  it('place les identifiants des sessions sélectionnées sous notre type MIME', () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
    const data = new DataTransfer();

    tree.handleDrag([sessionNode('s1'), sessionNode('s2')], data);

    expect(data.get(MIME)?.value).toEqual(['s1', 's2']);
  });

  it('ignore les nœuds qui ne sont pas des sessions (dossier sélectionné avec des sessions)', () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
    const data = new DataTransfer();

    tree.handleDrag([groupNode('g1', 'Dossier'), sessionNode('s1')], data);

    expect(data.get(MIME)?.value).toEqual(['s1']);
  });

  it('ne pose rien dans le transfert quand aucune session n est sélectionnée', () => {
    const tree = new SessionsTree(() => Promise.resolve(true));
    const data = new DataTransfer();

    tree.handleDrag([groupNode('g1', 'Dossier')], data);

    expect(data.get(MIME)).toBeUndefined();
  });
});

describe('SessionsTree — types MIME annoncés', () => {
  it("n'annonce que son propre type MIME, en glisser comme en déposer", () => {
    const tree = new SessionsTree(() => Promise.resolve(true));

    expect(tree.dropMimeTypes).toEqual([MIME]);
    expect(tree.dragMimeTypes).toEqual([MIME]);
  });
});
