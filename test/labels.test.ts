import { describe, expect, it } from 'vitest';
import { formatAge, formatAgeCoarse, formatTokens, sessionDescription, sessionLabel, sessionTooltip, statusLabel } from '../src/ui/labels';
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

  it('étiquette la session avec projet et branche en l absence de titre', () => {
    expect(sessionLabel(s)).toBe('projet · feat-seo');
    expect(sessionLabel({ ...s, branch: undefined })).toBe('projet');
  });

  it('affiche le titre de la conversation quand il existe', () => {
    expect(sessionLabel({ ...s, title: '#Koh-Vibe' })).toBe('#Koh-Vibe');
  });

  it('retombe sur projet · branche sans titre', () => {
    expect(sessionLabel({ ...s, title: undefined })).toBe('projet · feat-seo');
  });

  it('le projet reste lisible dans la description quand un titre occupe le libellé', () => {
    const d = sessionDescription({ ...s, title: '#Koh-Vibe', currentAction: undefined }, s.lastEventAt);
    expect(d).toContain('projet');
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

  it('retombe sur l âge seul quand rien ne se passe — la pastille dit le statut', () => {
    expect(sessionDescription({ ...s, status: 'idle', currentAction: undefined }, 60_000)).toBe('1 min');
  });

  it('n écrit jamais le statut en toutes lettres dans la description', () => {
    // Le mot ferait doublon avec la pastille ; il reste dans l infobulle.
    for (const status of ['running', 'waiting', 'done_unseen', 'idle', 'stale'] as const) {
      const d = sessionDescription({ ...s, status, currentAction: undefined }, 0);
      expect(d).not.toContain(statusLabel(status));
    }
  });

  it('garde le statut en toutes lettres dans l infobulle', () => {
    expect(sessionTooltip({ ...s, status: 'waiting' }, 0)).toContain(statusLabel('waiting'));
  });
});

describe('formatAgeCoarse', () => {
  it('reste stable pendant toute la première minute', () => {
    // C est cette stabilité qui permet à la vue de ne PAS se reconstruire toutes
    // les deux secondes, et donc à une infobulle de rester ouverte.
    for (const ms of [0, 1_000, 30_000, 59_999]) {
      expect(formatAgeCoarse(ms)).toBe("à l'instant");
    }
  });

  it('rejoint la précision à la minute au-delà', () => {
    expect(formatAgeCoarse(60_000)).toBe('1 min');
    expect(formatAgeCoarse(3_600_000)).toBe('1 h');
  });

  it('laisse l infobulle garder la précision à la seconde', () => {
    expect(formatAge(30_000)).toBe('30 s');
  });
});
