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
const MIME = 'application/vnd.code.tree.kohvibe.sessions';

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
    expect(onDrop).toHaveBeenCalledWith(['s1'], 'g-perso', ['s1']);
  });

  it('affecte plusieurs sessions déposées d un coup sur un dossier', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g-taf', 'Taf'), dataWith(['s1', 's2', 's3']));

    expect(onDrop).toHaveBeenCalledWith(['s1', 's2', 's3'], 'g-taf', ['s1', 's2', 's3']);
  });

  it('retire l affectation quand on dépose sur « Sans dossier »', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(unfiledNode(), dataWith(['s1']));

    expect(onDrop).toHaveBeenCalledWith(['s1'], undefined, ['s1']);
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

    expect(onDrop).toHaveBeenCalledWith(['s1', 's2'], 'g1', ['s1', 's2']);
  });

  it('ne change rien quand le tableau transporté ne contient aucune chaîne exploitable', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);

    await tree.handleDrop(groupNode('g1', 'Dossier'), dataWith([42, null]));

    expect(onDrop).not.toHaveBeenCalled();
  });

  // Une session est désormais une cible : on se place DEVANT elle. Le piège
  // reste le même qu'avant — `target.group` n'existe pas sur un nœud de
  // session, et le lire vaudrait `undefined`, donc « Sans dossier ». Le dossier
  // doit être celui de la session survolée, jamais celui du nœud déposé.
  it('dépose devant la session survolée, dans le dossier de CETTE session', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);
    tree.setSessions(new Map([['s1', session('s1')], ['s2', session('s2')], ['s3', session('s3')]]));
    tree.setGroups({
      groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
      assignments: { s1: 'g1', s2: 'g1', s3: 'g1' },
      sessionOrder: { g1: ['s1', 's2', 's3'] },
      unknown: {},
    });

    await tree.handleDrop(sessionNode('s2'), dataWith(['s3']));

    // Le dossier est bien g1 — et surtout PAS undefined, qui aurait sorti la
    // session de son dossier en croyant la réordonner.
    expect(onDrop).toHaveBeenCalledWith(['s3'], 'g1', ['s1', 's3', 's2']);
  });

  it('déposer une session sur elle-même ne la fait pas disparaître', async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const tree = new SessionsTree(() => Promise.resolve(true), onDrop);
    tree.setSessions(new Map([['s1', session('s1')], ['s2', session('s2')]]));
    tree.setGroups({
      groups: [{ id: 'g1', name: 'Dossier', order: 0 }],
      assignments: { s1: 'g1', s2: 'g1' },
      sessionOrder: { g1: ['s1', 's2'] },
      unknown: {},
    });

    await tree.handleDrop(sessionNode('s1'), dataWith(['s1']));

    expect(onDrop).toHaveBeenCalledWith(['s1'], 'g1', ['s1', 's2']);
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
    expect(onDrop).toHaveBeenCalledWith(['s1'], 'g1', ['s1']);
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
