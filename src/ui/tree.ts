import * as vscode from 'vscode';
import type { Session, Status } from '../events/types';
import { withStaleness } from '../store/staleness';
import { sessionDescription, sessionLabel, sessionTooltip, statusLabel } from './labels';
import { emptyGroups, groupIdOf, reorder, sessionOrderOf, type Group, type GroupsState } from '../groups/model';
import { themeColorOf } from './colors';
import { decorationUriParts } from './decorations';

export type TreeNode =
  // `group: undefined` désigne « Sans dossier », le reliquat des sessions non
  // rangées — pas un dossier au sens de l'utilisateur, voir contextValue plus bas.
  | { kind: 'group'; group: Group | undefined; sessions: Session[] }
  | { kind: 'session'; session: Session }
  // Une ligne vide entre deux dossiers. VSCode n'offre aucun réglage d'espacement
  // pour une vue d'arbre : la seule marge qu'une extension peut poser est une
  // ligne. Elle ne porte donc ni commande, ni contextValue, ni identifiant —
  // rien qui la rende cliquable ou ciblable par un dépôt.
  | { kind: 'spacer'; after: string }
  // La consommation mesurée par Claude Code, en tête de la vue. Absente tant que
  // le pont de statusline n'est pas installé — auquel cas la ligne n'existe pas,
  // plutôt que d'afficher zéro et de laisser croire à une consommation nulle.
  // `action` distingue « il faut installer les hooks », cliquable, de « rien à
  // afficher », qui ne doit rien déclencher.
  | { kind: 'empty'; message: string; action?: 'install' };

/**
 * La pastille de chaque statut : UN SEUL glyphe, cinq couleurs.
 *
 * Le glyphe est délibérément identique partout. Des glyphes différents —
 * `check`, `question`, `circle-outline`, `circle-slash` — ne se posaient pas au
 * même endroit dans la ligne, et le libellé qui les suit héritait du décalage :
 * les conversations ne s'alignaient pas. Un seul glyphe rend l'alignement vrai
 * par construction, et non plus par chance.
 *
 * La couleur, elle, reste obligatoire : une icône sans couleur n'est pas rendue
 * par le même chemin, ce qui décalait déjà les sessions à l'arrêt. Deux
 * invariants, un seul test pour les garder.
 *
 * Ce qu'on perd — la forme du triangle, de la coche — se retrouve dans
 * l'infobulle et dans le libellé d'accessibilité, qui nomment le statut.
 */
const STATUS_GLYPH = 'circle-filled';

const ICONS: Record<Status, { id: string; color: string }> = {
  running: { id: STATUS_GLYPH, color: 'charts.blue' },
  waiting: { id: STATUS_GLYPH, color: 'charts.yellow' },
  done_unseen: { id: STATUS_GLYPH, color: 'charts.green' },
  idle: { id: STATUS_GLYPH, color: 'descriptionForeground' },
  stale: { id: STATUS_GLYPH, color: 'disabledForeground' },
};

const ORDER: Record<Status, number> = { waiting: 0, running: 1, done_unseen: 2, idle: 3, stale: 4 };

/**
 * Le glyphe des dossiers : `symbol-folder`, qui est un dossier FERMÉ.
 *
 * VSCode traite `folder` et `file` à part : au lieu de dessiner le codicon, il
 * délègue au thème d'icônes de fichiers — et quand ce thème est « Aucun », il ne
 * dessine RIEN. Les forks n'ont pas tous ce cas particulier : la même machine
 * affichait donc un dossier dans un éditeur et rien dans l'autre.
 *
 * `symbol-folder` pointe sur EXACTEMENT le même dessin que `folder` (même point
 * de code, U+EA83) sous un autre nom — le cas particulier compare l'identifiant,
 * pas le glyphe. On récupère donc le dossier fermé, rendu partout de la même
 * façon, et qui garde la couleur du dossier au passage. `folder-opened`, qui
 * échappait au même piège, avait le défaut de montrer un dossier ouvert.
 */
const GROUP_GLYPH = 'symbol-folder';

/**
 * L'identité d'une ligne, stable d'un rendu à l'autre.
 *
 * Sans `id`, VSCode reconnaît une ligne à l'OBJET rendu par `getChildren` — et
 * nous en construisons de neufs à chaque tour. Chaque rafraîchissement,
 * fût-il déclenché par une seule minute qui tourne sur une seule session,
 * faisait donc détruire et reconstruire TOUTES les lignes : l'infobulle qu'on
 * était en train de lire disparaissait sous la souris. Ne plus rafraîchir pour
 * rien (voir `refresh`) espaçait le symptôme ; c'est l'identité qui le
 * supprime, parce qu'une ligne inchangée n'est alors plus refaite du tout.
 */
export function nodeId(node: TreeNode): string {
  switch (node.kind) {
    case 'group':
      return `group:${node.group?.id ?? 'unfiled'}`;
    case 'session':
      return `session:${node.session.id}`;
    case 'spacer':
      return `spacer:${node.after}`;
    default:
      return 'empty';
  }
}

function isSessionNode(node: TreeNode): node is Extract<TreeNode, { kind: 'session' }> {
  return node.kind === 'session';
}

/**
 * Retrouve l'identifiant du dossier ciblé par un menu contextuel
 * (kohVibe.renameGroup, kohVibe.deleteGroup) : pour une commande de
 * `view/item/context`, VSCode passe l'élément de l'arbre tel quel — jamais un
 * `TreeItem` — donc potentiellement n'importe quoi du point de vue du
 * typage. Validé sans cast, comme `handleDrop` : seul un nœud de dossier
 * NOMMÉ porte un identifiant ; « Sans dossier » (`group: undefined`) est déjà
 * exclu par le `when` du menu (`viewItem == group`), mais défendu ici quand
 * même plutôt que supposé.
 */
/**
 * L'identifiant de session ciblé par un menu contextuel. Même prudence que
 * `groupIdOfNode` : VSCode passe l'élément tel quel, donc n'importe quoi du
 * point de vue du typage.
 */
export function sessionIdOfNode(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const candidate = node as { kind?: unknown; session?: { id?: unknown } };
  if (candidate.kind !== 'session' || candidate.session === undefined) return undefined;
  return typeof candidate.session.id === 'string' ? candidate.session.id : undefined;
}

export function groupIdOfNode(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const candidate = node as { kind?: unknown; group?: { id?: unknown } };
  if (candidate.kind !== 'group' || candidate.group === undefined) return undefined;
  return typeof candidate.group.id === 'string' ? candidate.group.id : undefined;
}

/**
 * Intercale une ligne vide entre les dossiers — jamais avant le premier, qui
 * n'aurait rien à séparer, ni après le dernier, qui laisserait un blanc en bas
 * de la vue. Chaque séparateur porte l'identifiant du dossier
 * qu'il précède : VSCode distingue les éléments d'un arbre par leur identité,
 * et deux séparateurs indiscernables se marcheraient dessus au
 * rafraîchissement.
 */
function withSpacers(nodes: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (out.length > 0 && node.kind === 'group') {
      out.push({ kind: 'spacer', after: node.group?.id ?? 'unfiled' });
    }
    out.push(node);
  }
  return out;
}

export class SessionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
  // Type MIME qui nous est propre : c'est lui qui distingue un dépôt venu de
  // cet arbre (dont on connaît le format du contenu) d'un dépôt venu
  // d'ailleurs (un autre arbre, l'OS) — voir handleDrop.
  private static readonly MIME = 'application/vnd.code.tree.kohvibe.sessions';
  readonly dropMimeTypes = [SessionsTree.MIME];
  readonly dragMimeTypes = [SessionsTree.MIME];

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: Session[] = [];
  private groups: GroupsState = emptyGroups();
  // `undefined` = rien n'a encore été affiché : le premier rendu passe toujours.
  private rendered: string | undefined;

  constructor(
    // Reçoit la vérification plutôt que de la posséder : lire settings.json
    // toutes les REFRESH_MS pour un cas rare (aucune session) coûterait en
    // permanence. Consultée seulement quand ce nœud vide s'apprête à
    // s'afficher (I5) — jamais mise en cache au-delà d'un seul appel, pour
    // qu'une installation faite entre-temps se voie sans recharger la fenêtre.
    private readonly checkHooksInstalled: () => Promise<boolean>,
    // Signale une intention, comme checkHooksInstalled ci-dessus : la vue ne
    // connaît ni le fichier de classement ni updateGroups. Le câblage fournit
    // une fonction qui appelle updateGroups. Obligatoire et sans valeur par
    // défaut : un câblage oublié doit échouer à la compilation, pas produire
    // un glisser-déposer silencieusement inerte à l'exécution.
    private readonly onDrop: (
      sessionIds: readonly string[],
      groupId: string | undefined,
      order: readonly string[],
    ) => Promise<void>,
  ) {}

  setSessions(map: Map<string, Session>): void {
    const now = Date.now();
    this.sessions = [...map.values()]
      .map((s) => withStaleness(s, now))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastEventAt - a.lastEventAt);
    this.refresh();
  }

  // La vue affiche le classement, elle ne va pas le chercher : même principe
  // que checkHooksInstalled ci-dessus, pour la même raison de testabilité.
  setGroups(state: GroupsState): void {
    this.groups = state;
    this.refresh();
  }

  /**
   * Ce que la vue affiche RÉELLEMENT, sous forme comparable.
   *
   * Pas l'état brut : `lastEventAt` change à chaque événement, mais l'âge
   * affiché ne bouge qu'au passage d'une minute. Comparer ce qui est rendu, et
   * non ce qui le produit, est ce qui rend la comparaison utile.
   */
  private signature(): string {
    const now = Date.now();
    return JSON.stringify([
      this.sessions.map((s) => [
        s.id,
        s.status,
        sessionLabel(s),
        sessionDescription(s, now),
        groupIdOf(this.groups, s.id),
      ]),
      this.groups.groups,
      this.groups.sessionOrder,
    ]);
  }

  /**
   * Ne prévient VSCode que si l'affichage a changé.
   *
   * Le rendu tourne toutes les REFRESH_MS et appelle quatre setters : signaler
   * à chaque fois faisait reconstruire l'arbre deux fois par seconde, ce qui
   * escamotait l'infobulle sous la souris avant qu'on ait fini de la lire. Un
   * arbre qui n'a pas changé n'a rien à annoncer.
   */
  private refresh(): void {
    const next = this.signature();
    if (next === this.rendered) return;
    this.rendered = next;
    this.emitter.fire();
  }

  /**
   * Applique l'ordre choisi à la main. Les sessions qu'il nomme viennent en
   * tête, dans cet ordre ; celles qu'il ignore suivent, dans le tri du tableau
   * de bord — une session ouverte après un rangement se pose donc à la fin sans
   * bousculer ce qui a été placé.
   *
   * `sessions` arrive déjà trié (setSessions) : les restantes gardent cet ordre.
   */
  private ordered(sessions: readonly Session[], groupId: string | undefined): Session[] {
    const wanted = sessionOrderOf(this.groups, groupId);
    if (wanted.length === 0) return [...sessions];
    const rank = new Map(wanted.map((id, i) => [id, i]));
    const placed = sessions
      .filter((s) => rank.has(s.id))
      .map((s) => ({ s, at: rank.get(s.id) ?? 0 }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.s);
    return [...placed, ...sessions.filter((s) => !rank.has(s.id))];
  }

  /**
   * Le dossier où une session s'affiche réellement. Une affectation qui désigne
   * un dossier supprimé ne compte pas : la session est alors « Sans dossier »,
   * exactement comme dans getChildren — les deux ne doivent jamais diverger.
   */
  private groupOfSession(sessionId: string): string | undefined {
    const id = groupIdOf(this.groups, sessionId);
    return id !== undefined && this.groups.groups.some((g) => g.id === id) ? id : undefined;
  }

  /** L'ordre visible d'un dossier, tel qu'il est affiché à cet instant. */
  private visibleOrder(groupId: string | undefined): string[] {
    const sessions = this.sessions.filter((s) => this.groupOfSession(s.id) === groupId);
    return this.ordered(sessions, groupId).map((s) => s.id);
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node === undefined) {
      if (this.sessions.length === 0) {
        const installed = await this.checkHooksInstalled();
        if (!installed) {
          return [
            { kind: 'empty', message: 'Hooks non installés — cliquez pour les installer', action: 'install' },
          ];
        }
        return [{ kind: 'empty', message: 'Aucune session Claude Code active' }];
      }
      const knownIds = new Set(this.groups.groups.map((g) => g.id));
      const byGroup = new Map<string, Session[]>();
      const unfiled: Session[] = [];
      for (const s of this.sessions) {
        const groupId = groupIdOf(this.groups, s.id);
        if (groupId !== undefined && knownIds.has(groupId)) {
          const list = byGroup.get(groupId) ?? [];
          list.push(s);
          byGroup.set(groupId, list);
        } else {
          unfiled.push(s);
        }
      }
      // Les dossiers apparaissent tous, même vides — c'est une cible de dépôt ;
      // « Sans dossier » seulement s'il a un contenu, sinon ce reliquat n'a rien
      // à montrer, et toujours en dernier.
      const nodes: TreeNode[] = this.groups.groups.map((group) => ({
        kind: 'group',
        group,
        sessions: this.ordered(byGroup.get(group.id) ?? [], group.id),
      }));
      if (unfiled.length > 0) {
        nodes.push({ kind: 'group', group: undefined, sessions: this.ordered(unfiled, undefined) });
      }
      return withSpacers(nodes);
    }
    if (node.kind === 'group') return node.sessions.map((session) => ({ kind: 'session', session }));
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.message);
      item.id = 'empty';
      if (node.action === 'install') {
        item.command = { command: 'kohVibe.installHooks', title: 'Installer' };
      }
      return item;
    }
    if (node.kind === 'spacer') {
      // Un libellé vide, et rien d'autre : pas d'icône (qui la rendrait visible),
      // pas de commande (qui la rendrait cliquable), pas de contextValue (qui lui
      // donnerait un menu). Elle n'est là que pour occuper une hauteur de ligne.
      const item = new vscode.TreeItem('');
      item.id = nodeId(node);
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group?.name ?? 'Sans dossier', vscode.TreeItemCollapsibleState.Expanded);
      item.id = nodeId(node);
      item.description = `${node.sessions.length} session${node.sessions.length > 1 ? 's' : ''}`;
      // « Sans dossier » n'est pas un dossier : il ne se colore pas, faute de
      // pouvoir porter un choix de l'utilisateur.
      const theme = themeColorOf(node.group?.color);
      item.iconPath = new vscode.ThemeIcon(GROUP_GLYPH, theme === undefined ? undefined : new vscode.ThemeColor(theme));
      // Le libellé suit l'icône : c'est le fournisseur de décorations qui le
      // colore, seul moyen offert par VSCode d'atteindre le texte d'une ligne.
      if (theme !== undefined && node.group !== undefined) {
        item.resourceUri = vscode.Uri.from(decorationUriParts('group', node.group.id, theme));
      }
      // « Sans dossier » n'est pas un dossier de l'utilisateur : pas d'id, pas
      // de renommage ni de suppression possibles, donc pas ce contextValue.
      item.contextValue = node.group === undefined ? 'unfiled' : 'group';
      return item;
    }

    const s = node.session;
    const now = Date.now();
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None);
    item.id = nodeId(node);
    item.description = sessionDescription(s, now);
    item.tooltip = sessionTooltip(s, now);
    item.contextValue = 'session';
    item.accessibilityInformation = { label: `${sessionLabel(s)}, ${statusLabel(s.status)}` };
    const icon = ICONS[s.status];
    item.iconPath = new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color));
    // Volontairement AUCUNE couleur sur une session : la teinte du dossier
    // descendue sur ses conversations noyait la lecture, et posait en plus un
    // resourceUri qui décale le libellé. Le dossier porte la couleur, ses
    // sessions portent leur statut.
    item.command = { command: 'kohVibe.focusSession', title: 'Aller à la session', arguments: [s] };
    return item;
  }

  // Ce que l'utilisateur saisit dans le glisser : uniquement les sessions
  // sélectionnées, jamais un dossier — un dossier n'a pas de sens à être
  // déposé ailleurs dans cet arbre.
  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const ids = source.filter(isSessionNode).map((node) => node.session.id);
    if (ids.length > 0) data.set(SessionsTree.MIME, new vscode.DataTransferItem(ids));
  }

  // Le ciblage ne passe pas par contextValue : `target` est le nœud VSCode
  // sous le curseur. Seul un nœud de dossier (nommé ou « Sans dossier ») est
  // une cible valable — le vide de la vue (target undefined) ou toute autre
  // ligne ne change rien. `item.value` n'est jamais casté : il transite par
  // `unknown` et n'est accepté qu'après validation explicite de sa forme.
  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    // Deux cibles valables, et deux seulement : un dossier (on y range, à la
    // fin) ou une session (on se place devant elle, dans SON dossier). Le vide
    // de la vue, un séparateur ou le nœud d'état vide ne changent rien.
    if (target === undefined) return;
    if (target.kind !== 'group' && target.kind !== 'session') return;
    const item = data.get(SessionsTree.MIME);
    if (item === undefined) return;
    const ids: unknown = item.value;
    if (!Array.isArray(ids)) return;
    const sessionIds = ids.filter((id): id is string => typeof id === 'string');
    if (sessionIds.length === 0) return;

    const groupId = target.kind === 'group' ? target.group?.id : this.groupOfSession(target.session.id);
    const before = target.kind === 'session' ? target.session.id : undefined;
    // L'ordre transmis est celui du dossier APRÈS le dépôt, calculé sur ce qui
    // est affiché maintenant. Le figer entièrement est le but : une session
    // posée à la main ne doit plus bouger quand son statut change.
    await this.onDrop(sessionIds, groupId, reorder(this.visibleOrder(groupId), sessionIds, before));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
