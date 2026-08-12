import { describe, expect, it } from 'vitest';
import { branchOf, originOf, projectOf } from '../src/events/origin';

describe('originOf', () => {
  it('reconnaît les entrypoints connus', () => {
    expect(originOf('claude-vscode', '')).toBe('vscode');
    expect(originOf('claude-desktop', '')).toBe('desktop');
    expect(originOf('cli', 'ghostty')).toBe('terminal');
    expect(originOf('sdk-ts', '')).toBe('sdk');
    // sdk-cli : valeur réelle observée en capture headless (`claude -p`), Task 2.
    expect(originOf('sdk-cli', '')).toBe('sdk');
  });

  it('retombe sur le terminal hôte puis sur unknown', () => {
    expect(originOf('', 'vscode')).toBe('vscode');
    expect(originOf('', '')).toBe('unknown');
  });
});

describe('projectOf et branchOf', () => {
  it('prend le dossier racine hors worktree', () => {
    expect(projectOf('/Users/dev/projet')).toBe('projet');
    expect(branchOf('/Users/dev/projet')).toBeUndefined();
  });

  it('remonte au projet depuis un worktree et en tire la branche', () => {
    expect(projectOf('/Users/dev/projet/.worktrees/feat-seo')).toBe('projet');
    expect(branchOf('/Users/dev/projet/.worktrees/feat-seo')).toBe('feat-seo');
  });

  it('gère aussi .claude-worktrees', () => {
    expect(projectOf('/Users/dev/autre-projet/.claude-worktrees/analytics')).toBe('autre-projet');
    expect(branchOf('/Users/dev/autre-projet/.claude-worktrees/analytics')).toBe('analytics');
  });
});
