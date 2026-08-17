import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { SessionsTree, nodeId } from '../src/ui/tree';
import type { TreeNode } from '../src/ui/tree';
import type { Session } from '../src/events/types';
import type { ClosedEntry } from '../src/closed/model';

const EXT = '/ext';
const noopOnDrop = async (): Promise<void> => undefined;
const noopOnGroupsDropped = async (): Promise<void> => undefined;
const make = (): SessionsTree => new SessionsTree(async () => true, noopOnDrop, noopOnGroupsDropped, EXT);

const session = (id: string): Session => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'idle',
  toolCount: 0,
  lastEventAt: 0,
});

const closed = (id: string, over: Partial<ClosedEntry> = {}): ClosedEntry => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  closedAt: 0,
  ...over,
});

const kinds = async (tree: SessionsTree): Promise<string[]> =>
  (await tree.getChildren()).map((n) => n.kind);

const sectionOf = async (tree: SessionsTree): Promise<TreeNode | undefined> =>
  (await tree.getChildren()).find((n) => n.kind === 'closedGroup');

describe('the recently closed section', () => {
  it('does not exist while nothing has been closed', async () => {
    const tree = make();
    tree.setSessions(new Map([['a', session('a')]]));
    tree.setClosed([]);
    expect(await kinds(tree)).not.toContain('closedGroup');
  });

  it('appears last, after the folders', async () => {
    const tree = make();
    tree.setSessions(new Map([['a', session('a')]]));
    tree.setClosed([closed('z')]);
    expect((await kinds(tree)).at(-1)).toBe('closedGroup');
  });

  it('appears even when no session is alive, with the same separator line as every other section', async () => {
    const tree = make();
    tree.setSessions(new Map());
    tree.setClosed([closed('z')]);
    expect(await kinds(tree)).toEqual(['empty', 'spacer', 'closedGroup']);
  });

  it('lists its entries as children, newest first', async () => {
    const tree = make();
    tree.setSessions(new Map());
    tree.setClosed([closed('recent', { closedAt: 9 }), closed('older', { closedAt: 1 })]);
    const section = await sectionOf(tree);
    const rows = await tree.getChildren(section);
    expect(rows.map((r) => nodeId(r))).toEqual(['closed:recent', 'closed:older']);
  });

  it('hides an entry whose conversation is alive again', async () => {
    const tree = make();
    tree.setSessions(new Map([['a', session('a')]]));
    tree.setClosed([closed('a'), closed('b')]);
    const rows = await tree.getChildren(await sectionOf(tree));
    expect(rows.map((r) => nodeId(r))).toEqual(['closed:b']);
  });

  it('hides the whole section when every entry is alive again', async () => {
    const tree = make();
    tree.setSessions(new Map([['a', session('a')]]));
    tree.setClosed([closed('a')]);
    expect(await kinds(tree)).not.toContain('closedGroup');
  });

  it('starts collapsed, unlike the folders', async () => {
    const tree = make();
    tree.setSessions(new Map());
    tree.setClosed([closed('a')]);
    const section = await sectionOf(tree);
    const item = tree.getTreeItem(section!);
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('makes a row reopen on a single click, and keeps it out of the session menus', async () => {
    const tree = make();
    tree.setSessions(new Map());
    tree.setClosed([closed('a', { title: 'Titre' })]);
    const [row] = await tree.getChildren(await sectionOf(tree));
    const item = tree.getTreeItem(row!);
    expect(item.label).toBe('Titre');
    expect(item.contextValue).toBe('closedSession');
    expect(item.command?.command).toBe('kohVibe.reopenSession');
    expect(item.command?.arguments?.[0]).toMatchObject({ id: 'a' });
  });

  it('redraws when the closed list changes', async () => {
    const tree = make();
    tree.setSessions(new Map());
    let fired = 0;
    tree.onDidChangeTreeData(() => { fired += 1; });
    tree.setClosed([closed('a')]);
    expect(fired).toBe(1);
    tree.setClosed([closed('a')]);
    expect(fired).toBe(1);
    tree.setClosed([closed('a'), closed('b')]);
    expect(fired).toBe(2);
  });

  it('redraws when only the title changes, even though the description text stays identical', async () => {
    // A re-archive (Critical 1) can attach a title an entry did not have
    // before, without touching project, branch or closedAt — so
    // closedDescription() renders the same string either way. Only the
    // LABEL (sessionLabel) differs, and the signature must catch that.
    const tree = make();
    tree.setSessions(new Map());
    let fired = 0;
    tree.onDidChangeTreeData(() => { fired += 1; });
    tree.setClosed([closed('a', { title: 'Titre un' })]);
    expect(fired).toBe(1);
    tree.setClosed([closed('a', { title: 'Titre deux' })]);
    expect(fired).toBe(2);
  });
});
