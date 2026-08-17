import * as vscode from 'vscode';
import type { ClosedEntry } from './model';
import { sessionLabel } from '../ui/labels';

export type ReopenPlan =
  | { kind: 'command'; command: string; args: readonly string[] }
  | { kind: 'terminal'; cwd: string; name: string; command: string }
  | { kind: 'explain'; message: string };

/**
 * The only rule that decides how a closed conversation comes back. Twin of
 * `focusPlan`, and it follows the same discipline: an absent or invalid origin
 * NEVER falls back to a guessed command — reopening something the user did not
 * ask for is worse than explaining that we cannot.
 *
 * `origin` is not typed `Origin`: the remote path — the window consuming a
 * request written by another one — has only what an untrusted JSON file
 * carried, not a `ClosedEntry`.
 *
 * The session id reaches a command line in the terminal branch. It is safe
 * because every id has passed `isValidSessionId` twice: once at the spool
 * boundary, once when `closed.json` was read back.
 */
export function reopenPlan(origin: unknown, sessionId: string, cwd: string, label: string): ReopenPlan {
  if (origin === 'vscode' || origin === 'desktop') {
    return { kind: 'command', command: 'claude-vscode.editor.open', args: [sessionId] };
  }
  if (origin === 'terminal') {
    return { kind: 'terminal', cwd, name: label, command: `claude --resume ${sessionId}` };
  }
  const suffix = typeof origin === 'string' && origin.length > 0 ? ` (${origin})` : '';
  return {
    kind: 'explain',
    message: vscode.l10n.t('Koh-Vibe: « {0} » ran outside the editor and the terminal{1} — nothing to reopen here.', label, suffix),
  };
}

/**
 * Executes what a click on a closed conversation's row asks for. Extracted
 * out of the `kohVibe.reopenSession` command registration (extension.ts) for
 * the same reason `acknowledgeVisibleSessions`/`acknowledgeClickedSession`
 * were pulled out of extension.ts's onVisible/focusSession — see
 * `focus/acknowledge.ts`'s header comment: a composition point living
 * directly in extension.ts has no automated coverage, and a reviewer has
 * already proven by mutation, on this exact codebase, that a broken call
 * site can compile and stay green while only the pure primitive underneath
 * (here, `reopenPlan`) is tested.
 *
 * `requestReopen` is injected rather than importing `FocusBroker` directly —
 * the same shape as `checkHooksInstalled`/`onDrop` on `SessionsTree`, or the
 * `archive` callback on `SpoolWatcher`: this function does not need to know
 * HOW a `command`-kind plan reaches another window, only that something
 * does, so a test can drive it without constructing a broker.
 *
 * The `terminal` case is handled HERE, not delegated to `requestReopen`:
 * `FocusBroker.requestReopen` deliberately does nothing for it — the caller
 * opens the terminal locally, before `requestReopen` is even invoked.
 */
export async function reopenClosedSession(
  entry: ClosedEntry,
  requestReopen: (e: ClosedEntry) => Promise<void>,
): Promise<void> {
  const plan = reopenPlan(entry.origin, entry.id, entry.cwd, sessionLabel(entry));
  if (plan.kind === 'explain') {
    void vscode.window.showInformationMessage(plan.message);
    return;
  }
  if (plan.kind === 'terminal') {
    // A fresh terminal, on the conversation's folder: the old one is gone,
    // and koh-vibe does not yet know which one it was.
    const terminal = vscode.window.createTerminal({ cwd: plan.cwd, name: plan.name });
    terminal.sendText(plan.command);
    terminal.show();
    return;
  }
  // The tab can only come back in a window that holds the project: the
  // broker takes care of that, locally or by request. The catch stays — an
  // unhandled rejection would be worse — but a silently swallowed failure
  // here (full disk, `requests/` removed at runtime) would leave the click
  // doing and saying nothing, on a section whose only gesture IS this one.
  await requestReopen(entry).catch(() => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Koh-Vibe: could not reopen « {0} ».', sessionLabel(entry)),
    );
  });
}
