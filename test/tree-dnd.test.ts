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

// onDrop est obligatoire au constructeur (un câblage oublié doit échouer à la
// compilation, pas produire un glisser-déposer inerte à l'exécution) : ce
// bouchon partagé sert aux tests qui ne portent pas sur son appel lui-même.
const noopOnDrop = async (): Promise<void> => undefined;

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

  // Preuve par mutation : sans ce test, remplacer la garde par
  // `if (target === undefined) return;` laisse passer une session comme
  // cible. `target.group` n'existe pas sur un nœud de session — accéder à
  // cette propriété absente vaut `undefined` en JS, donc ce mutant appellerait
  // onDrop(ids, undefined), qui retirerait l'affectation en silence au lieu de
  // ne rien faire. La garde doit filtrer sur `kind === 'group'`, pas sur la
  // seule présence d'une cible.
  it('ignore un dépôt sur une session : ne retire pas silencieusement son affectation', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(sessionNode('s2'), dataWith(['s1']));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("ignore un dépôt sur le nœud d'état vide, pour la même raison", async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop({ kind: 'empty', message: 'Aucune session Claude Code active' }, dataWith(['s1']));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("un dépôt sur le dossier où la session se trouve déjà n'a pas d'effet différent d'une affectation normale", async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);
    const target: TreeNode = { kind: 'group', group: { id: 'g1', name: 'Dossier', order: 0 }, sessions: [session('s1')] };

    await tree.handleDrop(target, dataWith(['s1']));

    // Ni court-circuité (rien ne se passerait), ni doublé (une désaffectation
    // suivie d'une réaffectation) : le même appel unique qu'un dépôt sur
    // n'importe quel autre dossier — l'idempotence est la charge d'`onDrop`
    // (Task 9), pas celle de la vue.
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['s1'], 'g1');
  });
});

describe('SessionsTree — handleDrag (ce qui part dans le transfert)', () => {
  it('place les identifiants des sessions sélectionnées sous notre type MIME', () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    const data = new DataTransfer();

    tree.handleDrag([sessionNode('s1'), sessionNode('s2')], data);

    expect(data.get(MIME)?.value).toEqual(['s1', 's2']);
  });

  it('ignore les nœuds qui ne sont pas des sessions (dossier sélectionné avec des sessions)', () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    const data = new DataTransfer();

    tree.handleDrag([groupNode('g1', 'Dossier'), sessionNode('s1')], data);

    expect(data.get(MIME)?.value).toEqual(['s1']);
  });

  it('ne pose rien dans le transfert quand aucune session n est sélectionnée', () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);
    const data = new DataTransfer();

    tree.handleDrag([groupNode('g1', 'Dossier')], data);

    expect(data.get(MIME)).toBeUndefined();
  });
});

describe('SessionsTree — types MIME annoncés', () => {
  it("n'annonce que son propre type MIME, en glisser comme en déposer", () => {
    const tree = new SessionsTree(() => Promise.resolve(true), noopOnDrop);

    expect(tree.dropMimeTypes).toEqual([MIME]);
    expect(tree.dragMimeTypes).toEqual([MIME]);
  });
});
