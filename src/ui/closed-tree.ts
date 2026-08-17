import * as vscode from 'vscode';
import type { ClosedEntry } from '../closed/model';
import { closedDescription, closedTooltip, sessionLabel } from './labels';

/**
 * A row of the closed-conversation view, or the line standing in for an empty
 * one. `empty` carries no message: unlike the session tree's, which changes
 * with whether the hooks are installed, there is only ever one thing to say
 * here.
 */
export type ClosedNode =
  | { kind: 'entry'; entry: ClosedEntry }
  | { kind: 'empty' };

/** Stable identity of a row, so VSCode can tell two redraws apart. */
export function closedNodeId(node: ClosedNode): string {
  return node.kind === 'empty' ? 'closed:empty' : `closed:${node.entry.id}`;
}

/**
 * The recently closed conversations, as their own view beside the sessions,
 * the usage and the settings.
 *
 * It was a collapsible section at the bottom of the session tree until the
 * history grew to ten: there, it competed for room with the live sessions and
 * pushed them off screen. A view of its own is also why it no longer hides
 * when empty — a section that vanishes leaves nothing behind, but a view would
 * be left with its title and a blank body, which reads as a bug.
 */
export class ClosedTree implements vscode.TreeDataProvider<ClosedNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private entries: readonly ClosedEntry[] = [];
  private live: ReadonlySet<string> = new Set();
  // `undefined` = nothing drawn yet: the first render always goes through.
  private rendered: string | undefined;

  /**
   * Same principle as `SessionsTree.setGroups`: the view displays the closed
   * list, it does not go and fetch it.
   */
  setClosed(entries: readonly ClosedEntry[]): void {
    this.entries = entries;
    this.refresh();
  }

  /**
   * The conversations currently alive. Needed here, and not only in the
   * session tree, because an entry whose conversation came back must not show
   * in both views at once — see `visible()`.
   */
  setLive(ids: Iterable<string>): void {
    this.live = new Set(ids);
    this.refresh();
  }

  /**
   * The entries actually shown: one whose conversation is alive again is
   * filtered out here, never deleted from the file — the same conversation
   * must not appear twice in the window, and if it closes again it is archived
   * afresh.
   */
  private visible(): ClosedEntry[] {
    return this.entries.filter((e) => !this.live.has(e.id));
  }

  /**
   * What the view REALLY shows, in comparable form — not the raw state. The
   * label goes in as well as the description: once a re-archive attaches a
   * title the entry did not have before (see closed/model.ts's `remember`),
   * the label changes while the description can stay identical, and without it
   * that redraw would be missed.
   */
  private refresh(): void {
    const now = Date.now();
    const next = JSON.stringify(this.visible().map((e) => [e.id, sessionLabel(e), closedDescription(e, now)]));
    if (next === this.rendered) return;
    this.rendered = next;
    this.emitter.fire();
  }

  getChildren(node?: ClosedNode): ClosedNode[] {
    // A flat list: no row has children.
    if (node !== undefined) return [];
    const visible = this.visible();
    if (visible.length === 0) return [{ kind: 'empty' }];
    return visible.map((entry) => ({ kind: 'entry', entry }));
  }

  getTreeItem(node: ClosedNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(vscode.l10n.t('No closed conversation'));
      item.id = closedNodeId(node);
      // No command and no contextValue: nothing to open, and no menu that
      // could apply to a row standing in for an absence.
      return item;
    }
    const e = node.entry;
    const now = Date.now();
    const item = new vscode.TreeItem(sessionLabel(e), vscode.TreeItemCollapsibleState.None);
    item.id = closedNodeId(node);
    item.description = closedDescription(e, now);
    item.tooltip = closedTooltip(e, now);
    // Deliberately distinct from `session`: the session menus — sounds, remove
    // from the list, close, drag and drop — must not apply to a dead
    // conversation.
    item.contextValue = 'closedSession';
    item.accessibilityInformation = { label: `${sessionLabel(e)}, ${closedDescription(e, now)}` };
    // One glyph for every row: they have no status to tell apart, and a single
    // shape keeps the alignment true by construction — same reason as the
    // status dots on live sessions.
    item.iconPath = new vscode.ThemeIcon('history');
    item.command = {
      command: 'kohVibe.reopenSession',
      title: vscode.l10n.t('Reopen this conversation'),
      arguments: [e],
    };
    return item;
  }
}
