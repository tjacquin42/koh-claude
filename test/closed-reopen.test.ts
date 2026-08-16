import { describe, expect, it } from 'vitest';
import { reopenPlan } from '../src/closed/reopen';

const CWD = '/Users/dev/projet';

describe('reopenPlan', () => {
  it('reopens an editor conversation through the Claude Code command', () => {
    expect(reopenPlan('vscode', 's1', CWD, 'projet')).toEqual({
      kind: 'command',
      command: 'claude-vscode.editor.open',
      args: ['s1'],
    });
  });

  it('treats a desktop conversation like an editor one', () => {
    expect(reopenPlan('desktop', 's1', CWD, 'projet')).toMatchObject({ kind: 'command' });
  });

  it('reopens a terminal conversation in a terminal, on its own folder', () => {
    expect(reopenPlan('terminal', 's1', CWD, 'projet')).toEqual({
      kind: 'terminal',
      cwd: CWD,
      name: 'projet',
      command: 'claude --resume s1',
    });
  });

  it('explains rather than guesses for an origin it cannot reopen', () => {
    const plan = reopenPlan('sdk', 's1', CWD, 'projet');
    expect(plan.kind).toBe('explain');
    if (plan.kind === 'explain') expect(plan.message).toContain('sdk');
  });

  it('explains for a missing or wrongly typed origin, and names no origin', () => {
    for (const origin of [undefined, null, 42, {}]) {
      const plan = reopenPlan(origin, 's1', CWD, 'projet');
      expect(plan.kind).toBe('explain');
      if (plan.kind === 'explain') expect(plan.message).toContain('projet');
    }
  });
});
