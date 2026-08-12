import * as vscode from 'vscode';
import type { Session, Status } from '../events/types';
import { withStaleness } from '../store/staleness';
import { sessionDescription, sessionLabel, sessionTooltip, statusLabel } from './labels';

export type TreeNode =
  | { kind: 'project'; project: string; sessions: Session[] }
  | { kind: 'session'; session: Session }
  // `action` distingue « il faut installer les hooks », cliquable, de « rien à
  // afficher », qui ne doit rien déclencher.
  | { kind: 'empty'; message: string; action?: 'install' };

const ICONS: Record<Status, { id: string; color?: string }> = {
  running: { id: 'circle-filled', color: 'charts.blue' },
  waiting: { id: 'warning', color: 'charts.yellow' },
  done_unseen: { id: 'check', color: 'charts.green' },
  idle: { id: 'circle-outline' },
  stale: { id: 'circle-slash', color: 'disabledForeground' },
};

const ORDER: Record<Status, number> = { waiting: 0, running: 1, done_unseen: 2, idle: 3, stale: 4 };

export class SessionsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: Session[] = [];

  // Reçoit la vérification plutôt que de la posséder : lire settings.json
  // toutes les REFRESH_MS pour un cas rare (aucune session) coûterait en
  // permanence. Consultée seulement quand ce nœud vide s'apprête à
  // s'afficher (I5) — jamais mise en cache au-delà d'un seul appel, pour
  // qu'une installation faite entre-temps se voie sans recharger la fenêtre.
  constructor(private readonly checkHooksInstalled: () => Promise<boolean>) {}

  setSessions(map: Map<string, Session>): void {
    const now = Date.now();
    this.sessions = [...map.values()]
      .map((s) => withStaleness(s, now))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastEventAt - a.lastEventAt);
    this.emitter.fire();
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
      const byProject = new Map<string, Session[]>();
      for (const s of this.sessions) {
        const list = byProject.get(s.project) ?? [];
        list.push(s);
        byProject.set(s.project, list);
      }
      return [...byProject.entries()].map(([project, sessions]) => ({ kind: 'project', project, sessions }));
    }
    if (node.kind === 'project') return node.sessions.map((session) => ({ kind: 'session', session }));
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.message);
      if (node.action === 'install') {
        item.command = { command: 'kohClaude.installHooks', title: 'Installer' };
      }
      return item;
    }
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.project, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.sessions.length} session${node.sessions.length > 1 ? 's' : ''}`;
      item.contextValue = 'project';
      return item;
    }

    const s = node.session;
    const now = Date.now();
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None);
    item.description = sessionDescription(s, now);
    item.tooltip = sessionTooltip(s, now);
    item.contextValue = 'session';
    item.accessibilityInformation = { label: `${sessionLabel(s)}, ${statusLabel(s.status)}` };
    const icon = ICONS[s.status];
    item.iconPath = new vscode.ThemeIcon(
      icon.id,
      icon.color === undefined ? undefined : new vscode.ThemeColor(icon.color),
    );
    item.command = { command: 'kohClaude.focusSession', title: 'Aller à la session', arguments: [s] };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
