export type CloseOutcome = 'closed' | 'notFound';

/**
 * Ceiling on how long we wait for the tab model to catch up after a reveal.
 * The model is updated across the extension-host boundary: nothing guarantees
 * it is current the moment `executeCommand` settles. This is a net, not the
 * normal path — `settled()` resolves on the first tab change well before it.
 */
export const SETTLE_MS = 300;

/**
 * The window's Claude Code tabs, exactly as `closeSessionTab` needs them.
 *
 * An interface rather than direct calls to `vscode.window.tabGroups` so the
 * SEQUENCE below can be tested without a running editor — the same reason
 * `requestReopen` is injected into `reopenClosedSession` (closed/reopen.ts).
 * The adapter over the real API is `vscodeTabs()`, further down this file.
 *
 * `T` is the opaque handle of a tab: `vscode.Tab` in production, a string in
 * the tests. Generic rather than `unknown` so that `close()` cannot be handed
 * something `activeClaude()` never produced.
 */
export interface ClaudeTabs<T> {
  /** How many Claude Code tabs this window currently holds, all groups included. */
  count(): number;
  /** The active tab of the active group, but ONLY if it is a Claude Code tab. */
  activeClaude(): T | undefined;
  /** Reveals the panel of `sessionId` — and creates one if it finds none. */
  reveal(sessionId: string): Promise<void>;
  /** Resolves once the tab model has caught up with the reveal. */
  settled(): Promise<void>;
  close(tab: T): Promise<void>;
}

/**
 * Closes the tab of one conversation, and says whether it was really there.
 *
 * `reveal` is the only way to designate a session's panel — every Claude tab
 * carries the same label — but it CREATES one when it finds none. The count
 * taken before and after is what tells the two apart: it is a count and never
 * the identity of `Tab` objects, which is not guaranteed stable between two
 * reads of `tabGroups.all`.
 */
export async function closeSessionTab<T>(sessionId: string, tabs: ClaudeTabs<T>): Promise<CloseOutcome> {
  const before = tabs.count();
  try {
    await tabs.reveal(sessionId);
  } catch {
    // The Claude Code extension of this version exposes no such command, so no
    // tab here can be reached — which is precisely what `notFound` means. No
    // warning is raised: the caller then removes the row, and that IS the
    // documented behaviour when no tab is found.
    return 'notFound';
  }
  await tabs.settled();
  const after = tabs.count();
  const active = tabs.activeClaude();
  // Safe degradation: never close a tab we have not identified. This is also
  // what catches the one assumption no unit test can check — that a revealed
  // panel really becomes the active tab.
  if (active === undefined) return 'notFound';
  await tabs.close(active);
  // A tab APPEARED: the session had no panel here, `reveal` created one, and
  // we just closed our own creation. Nothing of the user's was found.
  return after > before ? 'notFound' : 'closed';
}
