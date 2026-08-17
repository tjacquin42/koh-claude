import { basename } from 'node:path';
import * as vscode from 'vscode';
import { isReopenable, type ClosedEntry } from '../closed/model';
import type { Session, Status } from '../events/types';

/**
 * Every string a user reads goes through `vscode.l10n.t`.
 *
 * The literal written here IS the English version — `t` returns its argument
 * when the editor's language has no bundle. Translations live in
 * `l10n/bundle.l10n.<lang>.json`, so a missing one degrades to English rather
 * than to an empty label.
 */
const STATUS: Record<Status, () => string> = {
  running: () => vscode.l10n.t('running'),
  waiting: () => vscode.l10n.t('waiting for you'),
  done_unseen: () => vscode.l10n.t('done'),
  idle: () => vscode.l10n.t('idle'),
  stale: () => vscode.l10n.t('stale'),
};

export function statusLabel(status: Status): string {
  return STATUS[status]();
}

export function formatAge(ms: number): string {
  // Truncated, not rounded: elapsed time reads downwards. Rounding would show
  // 90 s as "2 min", and 59.9 s as "60 s" instead of "1 min".
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return vscode.l10n.t('{0} s', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return vscode.l10n.t('{0} min', minutes);
  return vscode.l10n.t('{0} h', Math.floor(minutes / 60));
}

/**
 * The age as the LIST shows it: stable through the first minute, then to the
 * minute.
 *
 * `formatAge` counts seconds, which is accurate but makes the label different
 * on every render pass. The view uses it to decide whether anything needs
 * redrawing: text that moves every two seconds rebuilds the tree constantly and
 * snatches the tooltip out from under the pointer. The tooltip itself keeps the
 * precision — that is what it is opened for.
 */
export function formatAgeCoarse(ms: number): string {
  return ms < 60_000 ? vscode.l10n.t('just now') : formatAge(ms);
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  // Switches at 999,500 rather than 1,000,000: past that, rounding to thousands
  // would render "1000k", breaking the compact format instead of moving up.
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Where a session (live or closed) works: the project alone, or the project
 * and its branch joined by `separator`. Factored out because the same rule —
 * only the separator changes, `·` in a description, `/` in a tooltip — was
 * inlined four times across this file.
 */
function projectAndBranch(s: { project: string; branch?: string }, separator: string): string {
  return s.branch === undefined ? s.project : `${s.project}${separator}${s.branch}`;
}

/**
 * The title completes the line, it does not replace it: without one (the first
 * seconds of a session, before Claude sets it), falling back to project · branch
 * is the only thing left saying where the session works.
 */
export function sessionLabel(s: Pick<Session, 'title' | 'branch' | 'project'>): string {
  if (s.title !== undefined) return s.title;
  return projectAndBranch(s, ' · ');
}

// Whitespace — including the newlines of a multi-line Bash command — is
// normalised at the boundary (events/parse.ts, targetOf), not here: what
// reaches `currentAction.target` is already clean, as is
// `pendingPermission.summary`, which shares the same source. A second place
// repeating that normalisation would be the next trap: the one nobody
// remembers to keep in step with the first.
export function sessionDescription(s: Session, now: number): string {
  if (s.pendingPermission !== undefined) {
    return vscode.l10n.t('permission: {0}', s.pendingPermission.summary || s.pendingPermission.tool);
  }
  if (s.currentAction !== undefined) {
    const target = s.currentAction.target;
    return target === undefined ? s.currentAction.tool : `${s.currentAction.tool} ${basename(target)}`;
  }
  // The status is NOT spelled out here: the dot on the line (ui/tree.ts) already
  // carries it, by colour. The word does not disappear for all that — it stays
  // in the tooltip and in the accessibility label, the two places where an icon
  // is not enough.
  const age = formatAgeCoarse(now - s.lastEventAt);
  return s.title === undefined ? age : `${projectAndBranch(s, ' · ')} · ${age}`;
}

export function sessionTooltip(s: Session, now: number): string {
  const lines = [
    projectAndBranch(s, ' / '),
    `${statusLabel(s.status)} · ${formatAge(now - s.lastEventAt)}`,
    vscode.l10n.t('origin: {0}', s.origin),
    // Two strings rather than one with a suffix: no European language builds a
    // plural by appending a letter, and several do not build one at all.
    s.toolCount > 1 ? vscode.l10n.t('{0} tools', s.toolCount) : vscode.l10n.t('{0} tool', s.toolCount),
  ];
  if (s.tokens !== undefined) {
    lines.push(vscode.l10n.t('{0} in / {1} out', formatTokens(s.tokens.input), formatTokens(s.tokens.output)));
  }
  lines.push(s.cwd);
  return lines.join('\n');
}

/**
 * Where a closed conversation worked, and how long ago it ended.
 *
 * Coarse age, like the live rows: the tree compares what it renders to decide
 * whether to redraw, and a label that moves every second rebuilds the view
 * constantly. The precise age stays in the tooltip.
 *
 * Follows the same rule as `sessionDescription`: the label (`sessionLabel`)
 * already shows "project · branch" whenever there is no title, so repeating
 * it here would make the accessibility label read "projet, projet · closed 3
 * min" — the project said twice for no reason. `where` is prepended only once
 * a title has taken over the label.
 */
export function closedDescription(e: Pick<ClosedEntry, 'project' | 'branch' | 'title' | 'closedAt'>, now: number): string {
  const age = vscode.l10n.t('closed {0}', formatAgeCoarse(now - e.closedAt));
  return e.title === undefined ? age : `${projectAndBranch(e, ' · ')} · ${age}`;
}

export function closedTooltip(e: ClosedEntry, now: number): string {
  const lines = [
    projectAndBranch(e, ' / '),
    vscode.l10n.t('closed {0} ago', formatAge(now - e.closedAt)),
    vscode.l10n.t('origin: {0}', e.origin),
  ];
  // Only promise what `reopenPlan` can actually deliver: `sdk`/`unknown`
  // origins always resolve to an `explain` plan, never a reopen.
  if (isReopenable(e.origin)) lines.push(vscode.l10n.t('Click to reopen'));
  lines.push(e.cwd);
  return lines.join('\n');
}
