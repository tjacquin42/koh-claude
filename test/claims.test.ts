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

  it('revendique indépendamment de la casse (macOS insensible à la casse)', () => {
    expect(claims(folders, '/users/jack/dev/pity-tidy')).toBe(true);
    expect(claims(folders, '/Users/jack/DEV/PITY-TIDY/web')).toBe(true);
  });

  it('ne revendique toujours pas le préfixe trompeur, même avec une casse différente', () => {
    expect(claims(folders, '/Users/jack/DEV/PITY-TIDY-old')).toBe(false);
  });
});
