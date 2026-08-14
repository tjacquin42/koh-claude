import { describe, expect, it } from 'vitest';
import { decorationColorOf, decorationUriParts, KOH_SCHEME } from '../src/ui/decorations';

describe('decorationUriParts', () => {
  it('porte la couleur dans l URI, pas dans un état tenu à côté', () => {
    expect(decorationUriParts('group', 'g-1', 'charts.green')).toEqual({
      scheme: KOH_SCHEME,
      authority: 'group',
      path: '/g-1',
      query: 'c=charts.green',
    });
  });

  it('distingue un dossier d une session portant le même identifiant', () => {
    const g = decorationUriParts('group', 'x', 'charts.red');
    const s = decorationUriParts('session', 'x', 'charts.red');
    expect(g.authority).not.toBe(s.authority);
  });

  it('change quand la couleur change — c est ce qui fait redemander la décoration', () => {
    expect(decorationUriParts('group', 'g-1', 'charts.red').query).not.toBe(
      decorationUriParts('group', 'g-1', 'charts.blue').query,
    );
  });
});

describe('decorationColorOf', () => {
  it('relit la couleur qu on a posée', () => {
    const parts = decorationUriParts('group', 'g-1', 'charts.green');
    expect(decorationColorOf(parts)).toBe('charts.green');
  });

  it('ne teinte jamais une ressource qui n est pas à nous', () => {
    // Ce fournisseur est appelé pour CHAQUE ressource affichée par VSCode :
    // un fichier de l utilisateur dont la query ressemblerait à la nôtre ne
    // doit pas changer de couleur.
    expect(decorationColorOf({ scheme: 'file', query: 'c=charts.red' })).toBeUndefined();
    expect(decorationColorOf({ scheme: 'https', query: 'c=charts.red' })).toBeUndefined();
  });

  it('rend undefined quand la couleur manque ou est vide', () => {
    expect(decorationColorOf({ scheme: KOH_SCHEME, query: '' })).toBeUndefined();
    expect(decorationColorOf({ scheme: KOH_SCHEME, query: 'c=' })).toBeUndefined();
    expect(decorationColorOf({ scheme: KOH_SCHEME, query: 'autre=charts.red' })).toBeUndefined();
  });
});
