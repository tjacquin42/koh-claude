import { describe, expect, it } from 'vitest';
import { claims, sessionsToAcknowledge } from '../src/focus/claims';
import type { Session } from '../src/events/types';

describe('claims', () => {
  const folders = ['/Users/dev/projet', '/Users/dev/autre-projet'];

  it('revendique une session dans un dossier du workspace', () => {
    expect(claims(folders, '/Users/dev/projet')).toBe(true);
    expect(claims(folders, '/Users/dev/projet/web')).toBe(true);
  });

  it('revendique un worktree situé sous le dossier', () => {
    expect(claims(folders, '/Users/dev/projet/.worktrees/feat-seo')).toBe(true);
  });

  it('ne revendique pas un projet voisin au préfixe trompeur', () => {
    expect(claims(folders, '/Users/dev/projet-old')).toBe(false);
  });

  it('ne revendique rien sans dossier ouvert', () => {
    expect(claims([], '/Users/dev/projet')).toBe(false);
  });

  it('revendique indépendamment de la casse (macOS insensible à la casse)', () => {
    expect(claims(folders, '/users/dev/projet')).toBe(true);
    expect(claims(folders, '/Users/dev/PROJET/web')).toBe(true);
  });

  it('ne revendique toujours pas le préfixe trompeur, même avec une casse différente', () => {
    expect(claims(folders, '/Users/dev/PROJET-old')).toBe(false);
  });
});

// I6 : la spec (§5) acquitte « terminé non lu » à l'affichage de la vue
// seulement pour la fenêtre qui revendique la session — pas pour toutes les
// sessions de tous les projets. Extraite en fonction pure (même raison que
// claims() elle-même) pour rester testable sans vscode : c'est exactement la
// logique câblée dans onDidChangeVisibility (extension.ts).
describe('sessionsToAcknowledge', () => {
  const base: Session = {
    id: 's', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode',
    status: 'done_unseen', toolCount: 0, lastEventAt: 0,
  };
  const folders = ['/Users/dev/projet'];

  it('retient les sessions terminées non lues que ces dossiers revendiquent', () => {
    const claimed: Session = { ...base, id: 'a', cwd: '/Users/dev/projet' };
    const foreign: Session = { ...base, id: 'b', cwd: '/Users/dev/autre-projet' };
    expect(sessionsToAcknowledge([claimed, foreign], folders)).toEqual([claimed]);
  });

  it('ignore une session revendiquée mais pas terminée non lue', () => {
    const running: Session = { ...base, id: 'a', status: 'running' };
    expect(sessionsToAcknowledge([running], folders)).toEqual([]);
  });

  it('ne retient rien sans dossier ouvert', () => {
    expect(sessionsToAcknowledge([base], [])).toEqual([]);
  });
});
