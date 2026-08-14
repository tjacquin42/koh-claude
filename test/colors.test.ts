import { describe, expect, it } from 'vitest';
import { colorChoice, GROUP_COLORS, NO_COLOR_LABEL, themeColorOf } from '../src/ui/colors';

describe('palette', () => {
  it('n\'expose que des couleurs de thème, jamais un code en dur', () => {
    for (const c of GROUP_COLORS) expect(c.theme).toMatch(/^charts\./);
  });

  it('porte des identifiants et des libellés tous distincts', () => {
    expect(new Set(GROUP_COLORS.map((c) => c.id)).size).toBe(GROUP_COLORS.length);
    expect(new Set(GROUP_COLORS.map((c) => c.label)).size).toBe(GROUP_COLORS.length);
  });

  it('n\'utilise pas le libellé « Aucune » pour une vraie couleur', () => {
    expect(GROUP_COLORS.some((c) => c.label === NO_COLOR_LABEL)).toBe(false);
  });
});

describe('themeColorOf', () => {
  it('traduit un identifiant connu en couleur de thème', () => {
    expect(themeColorOf('blue')).toBe('charts.blue');
  });

  it('affiche sans couleur ce qu\'il ne connaît pas, plutôt que de casser la vue', () => {
    expect(themeColorOf('turquoise')).toBeUndefined();
    expect(themeColorOf('')).toBeUndefined();
    expect(themeColorOf(undefined)).toBeUndefined();
  });
});

describe('colorChoice', () => {
  it('pose la couleur choisie', () => {
    expect(colorChoice('Bleu')).toEqual({ kind: 'set', color: 'blue' });
  });

  it('retire la couleur sur « Aucune » — c\'est un choix, pas une absence', () => {
    expect(colorChoice(NO_COLOR_LABEL)).toEqual({ kind: 'set', color: undefined });
  });

  it('ne touche à rien quand la liste est fermée sans choisir', () => {
    expect(colorChoice(undefined)).toEqual({ kind: 'cancel' });
  });

  it('annule plutôt que d\'effacer devant un libellé inconnu', () => {
    // Le pire résultat possible serait un effacement silencieux : fermer et
    // choisir n'importe quoi ne doivent jamais retirer une couleur par accident.
    expect(colorChoice('Turquoise')).toEqual({ kind: 'cancel' });
    expect(colorChoice('')).toEqual({ kind: 'cancel' });
  });
});
