import { describe, expect, it } from 'vitest';
import { claims } from '../src/focus/claims';

describe('claims', () => {
  const folders = ['/Users/jack/DEV/pity-tidy', '/Users/jack/DEV/Vetibble'];

  it('revendique une session dans un dossier du workspace', () => {
    expect(claims(folders, '/Users/jack/DEV/pity-tidy')).toBe(true);
    expect(claims(folders, '/Users/jack/DEV/pity-tidy/web')).toBe(true);
  });

  it('revendique un worktree situé sous le dossier', () => {
    expect(claims(folders, '/Users/jack/DEV/pity-tidy/.worktrees/feat-seo')).toBe(true);
  });

  it('ne revendique pas un projet voisin au préfixe trompeur', () => {
    expect(claims(folders, '/Users/jack/DEV/pity-tidy-old')).toBe(false);
  });

  it('ne revendique rien sans dossier ouvert', () => {
    expect(claims([], '/Users/jack/DEV/pity-tidy')).toBe(false);
  });
});
