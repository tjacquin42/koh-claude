import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { reopenClosedSession, reopenPlan } from '../src/closed/reopen';
import type { ClosedEntry } from '../src/closed/model';
import type { StubTerminal } from './stubs/vscode';

const CWD = '/Users/dev/projet';

function entry(over: Partial<ClosedEntry> = {}): ClosedEntry {
  return { id: 's1', cwd: CWD, project: 'projet', origin: 'terminal', closedAt: 0, ...over };
}

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

// Extracted out of the `kohVibe.reopenSession` command registration
// (extension.ts) for the same reason `acknowledgeVisibleSessions`/
// `acknowledgeClickedSession` were pulled out of extension.ts's
// onVisible/focusSession (see focus/acknowledge.ts): a composition point
// living directly in extension.ts has no automated coverage, and a reviewer
// proved by mutation, on this exact codebase, that a broken call site can
// compile and stay green while only the pure primitive underneath
// (`reopenPlan`) is tested.
describe('reopenClosedSession', () => {
  it("opens a terminal on the conversation's own folder for a terminal origin, sends the resume command, and shows it", async () => {
    const sendText = vi.fn();
    const show = vi.fn();
    const terminal: StubTerminal = { sendText, show };
    const createTerminal = vi
      .spyOn(vscode.window, 'createTerminal')
      // `@types/vscode`'s ambient `Terminal` has dozens of members that only
      // the real editor ever provides; `StubTerminal` (test/stubs/vscode.ts),
      // and this code, only ever touch `sendText`/`show` — so the substitute
      // is cast rather than pretending to satisfy the rest of that interface.
      .mockReturnValue(terminal as unknown as vscode.Terminal);
    const requestReopen = vi.fn().mockResolvedValue(undefined);
    const e = entry({ id: 's9', cwd: '/Users/dev/autre-projet', project: 'autre-projet', origin: 'terminal' });

    await reopenClosedSession(e, requestReopen);

    expect(createTerminal).toHaveBeenCalledWith({ cwd: '/Users/dev/autre-projet', name: 'autre-projet' });
    expect(sendText).toHaveBeenCalledWith('claude --resume s9');
    expect(show).toHaveBeenCalled();
    expect(requestReopen).not.toHaveBeenCalled();
  });

  it('shows the explanation locally and creates no terminal for an origin reopenPlan cannot reopen', async () => {
    const createTerminal = vi.spyOn(vscode.window, 'createTerminal');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const requestReopen = vi.fn().mockResolvedValue(undefined);

    await reopenClosedSession(entry({ origin: 'sdk' }), requestReopen);

    expect(info).toHaveBeenCalled();
    expect(createTerminal).not.toHaveBeenCalled();
    expect(requestReopen).not.toHaveBeenCalled();
  });

  it('delegates to the injected requestReopen for an editor conversation, and creates no terminal', async () => {
    const createTerminal = vi.spyOn(vscode.window, 'createTerminal');
    const requestReopen = vi.fn().mockResolvedValue(undefined);
    const e = entry({ origin: 'vscode' });

    await reopenClosedSession(e, requestReopen);

    expect(requestReopen).toHaveBeenCalledWith(e);
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('does not let a rejection from the injected requestReopen escape', async () => {
    const requestReopen = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(reopenClosedSession(entry({ origin: 'vscode' }), requestReopen)).resolves.toBeUndefined();
  });
});
