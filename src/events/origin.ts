import type { Origin } from './types';

const WORKTREE_MARKERS = ['.worktrees', '.claude-worktrees'];

export function originOf(entrypoint: string, termProgram: string): Origin {
  switch (entrypoint) {
    case 'claude-vscode':
      return 'vscode';
    case 'claude-desktop':
      return 'desktop';
    case 'cli':
      return 'terminal';
    case 'sdk-ts':
    case 'sdk-py':
    case 'sdk-cli':
      return 'sdk';
    default:
      return termProgram === 'vscode' ? 'vscode' : 'unknown';
  }
}

function segments(cwd: string): string[] {
  return cwd.split('/').filter((p) => p.length > 0);
}

function worktreeIndex(parts: string[]): number {
  return parts.findIndex((p) => WORKTREE_MARKERS.includes(p));
}

/** Nom du projet : le dossier racine, en remontant au-dessus d'un worktree. */
export function projectOf(cwd: string): string {
  const parts = segments(cwd);
  const wt = worktreeIndex(parts);
  const idx = wt > 0 ? wt - 1 : parts.length - 1;
  return parts[idx] ?? cwd;
}

/** Nom du worktree, qui sert de nom de branche. `undefined` sur le dépôt principal. */
export function branchOf(cwd: string): string | undefined {
  const parts = segments(cwd);
  const wt = worktreeIndex(parts);
  if (wt < 0) return undefined;
  return parts[wt + 1];
}
