import { describe, expect, it } from 'vitest';
import { closeSessionTab, type ClaudeTabs } from '../src/close/tabs';

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
