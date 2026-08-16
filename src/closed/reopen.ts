import * as vscode from 'vscode';

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
