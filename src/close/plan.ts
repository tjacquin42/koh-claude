/**
 * The only rule that decides what a click on the trash can do. Third twin of
 * `focusPlan` (focus/plan.ts) and `reopenPlan` (closed/reopen.ts), and it
 * follows the same discipline: an absent or invalid origin NEVER falls back to
 * a guessed action.
 *
 * `origin` is typed `unknown` rather than `Origin` for the same reason as its
 * two twins: the remote path — the window consuming a request written by
 * another one — has only what an untrusted JSON file carried, not a `Session`.
 *
 * Deliberate divergence from `focusPlan`: that one treats `desktop` like
 * `vscode` and sends it to `claude-vscode.editor.open`, which CREATES a panel
 * when it finds none. Creating a tab is a debatable way to focus something;
 * it is an absurd way to close it. `desktop` therefore forgets here.
 */
export type ClosePlan =
  | { kind: 'tab' }
  | { kind: 'forget' };

export function closePlan(origin: unknown): ClosePlan {
  return origin === 'vscode' ? { kind: 'tab' } : { kind: 'forget' };
}
