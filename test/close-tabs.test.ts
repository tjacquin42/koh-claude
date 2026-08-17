import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { claudeTabsOf, closeSessionTab, SETTLE_MS, vscodeTabs, type ClaudeTabs } from '../src/close/tabs';
import { stubTabGroups, tabChange, TabInputWebview, type StubTab } from './stubs/vscode';

interface Recorder {
  log: string[];
  revealed: string[];
  closed: string[];
}

function recorder(): Recorder {
  return { log: [], revealed: [], closed: [] };
}

/**
 * A fake window: `counts` is what `count()` answers on its first and second
 * call, `active` what the active tab is (undefined = not a Claude tab).
 * Every call is logged so a test can assert the ORDER, not only the effects.
 */
function tabs(
  rec: Recorder,
  counts: readonly [number, number],
  active: string | undefined,
  revealFails = false,
): ClaudeTabs<string> {
  let calls = 0;
  return {
    count: () => {
      rec.log.push('count');
      calls += 1;
      return calls === 1 ? counts[0] : counts[1];
    },
    activeClaude: () => {
      rec.log.push('activeClaude');
      return active;
    },
    reveal: async (id: string) => {
      rec.log.push('reveal');
      rec.revealed.push(id);
      if (revealFails) throw new Error('command not found');
    },
    settled: async () => {
      rec.log.push('settled');
    },
    close: async (tab: string) => {
      rec.log.push('close');
      rec.closed.push(tab);
    },
  };
}

describe('closeSessionTab', () => {
  it('closes the revealed panel and reports the conversation closed', async () => {
    const rec = recorder();
    const outcome = await closeSessionTab('s1', tabs(rec, [2, 2], 'panel'));

    expect(outcome).toBe('closed');
    expect(rec.revealed).toEqual(['s1']);
    expect(rec.closed).toEqual(['panel']);
  });

  it('reports nothing found when the reveal had to CREATE the panel, and closes what it created', async () => {
    const rec = recorder();
    const outcome = await closeSessionTab('s1', tabs(rec, [2, 3], 'panel'));

    expect(outcome).toBe('notFound');
    expect(rec.closed).toEqual(['panel']);
  });

  it('closes nothing when the active tab is not a Claude Code one', async () => {
    const rec = recorder();
    const outcome = await closeSessionTab('s1', tabs(rec, [2, 2], undefined));

    expect(outcome).toBe('notFound');
    expect(rec.closed).toEqual([]);
  });

  it('reports nothing found, and closes nothing, when the reveal command is missing', async () => {
    const rec = recorder();
    const outcome = await closeSessionTab('s1', tabs(rec, [2, 2], 'panel', true));

    expect(outcome).toBe('notFound');
    expect(rec.closed).toEqual([]);
    expect(rec.log).toEqual(['count', 'reveal']);
  });

  it('lets the tab model settle between the two counts, never counting twice in a row', async () => {
    const rec = recorder();
    await closeSessionTab('s1', tabs(rec, [2, 2], 'panel'));

    expect(rec.log).toEqual(['count', 'reveal', 'settled', 'count', 'activeClaude', 'close']);
  });
});

const claudeTab = (): StubTab => ({ input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') });
const otherTab = (): StubTab => ({ input: new TabInputWebview('mainThreadWebview-markdown.preview') });

describe('vscodeTabs', () => {
  beforeEach(() => {
    stubTabGroups.all = [];
    stubTabGroups.activeTabGroup = { tabs: [], activeTab: undefined };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts the Claude Code tabs of every group, and ignores the others', () => {
    const a = claudeTab();
    const b = claudeTab();
    stubTabGroups.all = [
      { tabs: [a, otherTab()], activeTab: a },
      { tabs: [b], activeTab: b },
    ];

    expect(claudeTabsOf(stubTabGroups.all as unknown as readonly vscode.TabGroup[]).length).toBe(2);
    expect(vscodeTabs().count()).toBe(2);
  });

  it('offers the active tab only when it is a Claude Code one', () => {
    const claude = claudeTab();
    stubTabGroups.activeTabGroup = { tabs: [claude], activeTab: claude };
    expect(vscodeTabs().activeClaude()).toBe(claude);

    const other = otherTab();
    stubTabGroups.activeTabGroup = { tabs: [other], activeTab: other };
    expect(vscodeTabs().activeClaude()).toBeUndefined();

    stubTabGroups.activeTabGroup = { tabs: [], activeTab: undefined };
    expect(vscodeTabs().activeClaude()).toBeUndefined();
  });

  it('reveals a panel through the Claude Code command, with the session id', async () => {
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await vscodeTabs().reveal('s1');
    expect(executeCommand).toHaveBeenCalledWith('claude-vscode.editor.open', 's1');
  });

  it('closes through the tab groups API', async () => {
    const tab = claudeTab();
    const close = vi.spyOn(stubTabGroups, 'close').mockResolvedValue(true);
    await vscodeTabs().close(tab as unknown as vscode.Tab);
    expect(close).toHaveBeenCalledWith(tab);
  });

  it('settles as soon as the tab model reports a change, without waiting out the ceiling', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = vscodeTabs()
      .settled()
      .then(() => {
        settled = true;
      });

    tabChange.fire();
    await pending;
    expect(settled).toBe(true);
  });

  it('settles anyway when no tab change is ever reported', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = vscodeTabs()
      .settled()
      .then(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await pending;
    expect(settled).toBe(true);
  });
});
