import { describe, expect, it } from 'vitest';
import { formatAge, formatTokens, sessionDescription, sessionLabel, statusLabel } from '../src/ui/labels';
import type { Session } from '../src/events/types';

const s: Session = {
  id: 'abc', cwd: '/Users/dev/projet/.worktrees/feat-seo',
  project: 'projet', branch: 'feat-seo', origin: 'vscode',
  status: 'running', toolCount: 47, lastEventAt: 0,
  currentAction: { tool: 'Edit', target: '/Users/dev/projet/web/nuxt.config.ts' },
  tokens: { input: 128_000, output: 4_200 },
};

describe('labels', () => {
  it('nomme les cinq statuts en français', () => {
    expect(statusLabel('running')).toBe('en cours');
    expect(statusLabel('waiting')).toBe("t'attend");
    expect(statusLabel('done_unseen')).toBe('terminé');
    expect(statusLabel('idle')).toBe("à l'arrêt");
    expect(statusLabel('stale')).toBe('périmée');
  });

  it('formate les durées court', () => {
    expect(formatAge(5_000)).toBe('5 s');
    expect(formatAge(90_000)).toBe('1 min');
    expect(formatAge(3 * 3_600_000)).toBe('3 h');
  });

  it('formate les tokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('ne produit jamais « 1000k » aux frontières', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1.0M');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });

  it('étiquette la session avec sa branche', () => {
    expect(sessionLabel(s)).toBe('feat-seo');
    expect(sessionLabel({ ...s, branch: undefined })).toBe('projet');
  });

  it('décrit l action en cours par le nom de fichier seul', () => {
    expect(sessionDescription(s, 0)).toBe('Edit nuxt.config.ts');
  });

  it('décrit la permission attendue en priorité', () => {
    const waiting: Session = {
      ...s, status: 'waiting', pendingPermission: { tool: 'Bash', summary: 'rm -rf dist' },
    };
    expect(sessionDescription(waiting, 0)).toBe('permission : rm -rf dist');
  });

  it('retombe sur le statut et l âge quand rien ne se passe', () => {
    expect(sessionDescription({ ...s, status: 'idle', currentAction: undefined }, 60_000)).toBe("à l'arrêt · 1 min");
  });
});
