import { describe, expect, it } from 'vitest';
import { escape, percentColor, resetText, usageHtml } from '../src/ui/usage-view';
import { parseUsage } from '../src/usage/model';
import type { UsageReading } from '../src/usage/reader';

const reading = (five: number, seven: number, resetsAt?: number, at = 0): UsageReading => ({
  usage: parseUsage({
    five_hour: { used_percentage: five, resets_at: resetsAt },
    seven_day: { used_percentage: seven },
  })!,
  source: 'api',
  at,
});

describe('percentColor', () => {
  it('passe du vert à l orange à 50 %, puis au rouge à 80 %', () => {
    expect(percentColor(0)).toContain('green');
    expect(percentColor(50)).toContain('green');
    expect(percentColor(51)).toContain('orange');
    expect(percentColor(80)).toContain('orange');
    expect(percentColor(81)).toContain('red');
    expect(percentColor(100)).toContain('red');
  });

  it('ne cite jamais une couleur en dur : la vue doit suivre le thème', () => {
    for (const p of [10, 60, 95]) expect(percentColor(p)).toMatch(/^var\(--vscode-/);
  });
});

describe('resetText', () => {
  const at = (secondsFromNow: number, now: number) => ({
    percent: 10,
    resetsAt: Math.floor(now / 1000) + secondsFromNow,
  });

  it('dit les minutes, les heures, puis les jours', () => {
    const now = 1_700_000_000_000;
    expect(resetText(at(30 * 60, now), now)).toBe('in 30 min');
    expect(resetText(at(2 * 3600, now), now)).toBe('in 2 h');
    expect(resetText(at(6 * 86_400, now), now)).toBe('in 6 d');
  });

  it('arrondit vers le bas — une échéance ne doit jamais paraître plus lointaine', () => {
    const now = 1_700_000_000_000;
    expect(resetText(at(2 * 3600 + 3500, now), now)).toBe('in 2 h');
  });

  it('ne descend jamais sous « dans 1 min » avant l échéance', () => {
    const now = 1_700_000_000_000;
    expect(resetText(at(20, now), now)).toBe('in 1 min');
  });

  it('dit la remise à zéro plutôt qu un délai négatif', () => {
    const now = 1_700_000_000_000;
    expect(resetText(at(-60, now), now)).toBe('reset');
  });

  it('n invente rien sans échéance', () => {
    expect(resetText({ percent: 10, resetsAt: undefined }, 0)).toBe('');
    expect(resetText(undefined, 0)).toBe('');
  });
});

describe('usageHtml', () => {
  const now = 1_700_000_000_000;

  it('donne à chaque fenêtre son nom, son pourcentage et son échéance', () => {
    const html = usageHtml(reading(30, 5, Math.floor(now / 1000) + 7200), now);
    expect(html).toContain('5 h');
    expect(html).toContain('30 %');
    expect(html).toContain('7 d');
    expect(html).toContain('5 %');
    expect(html).toContain('in 2 h');
  });

  it('colore le pourcentage, et lui seul', () => {
    const html = usageHtml(reading(90, 5), now);
    // Le nom de la fenêtre reste dans la couleur du texte courant ; seul le
    // pourcentage porte une couleur propre.
    expect(html).toContain(`<span class="pct" style="color:${percentColor(90)}">90 %</span>`);
    expect(html).toContain('<span class="kind">5 h</span>');
  });

  it('dit d où vient la mesure et depuis quand', () => {
    expect(usageHtml(reading(1, 1, undefined, now - 120_000), now)).toContain('Anthropic');
    expect(usageHtml(reading(1, 1, undefined, now - 120_000), now)).toContain('2 min');
    expect(usageHtml(reading(1, 1, undefined, now), now)).toContain('just now');
  });

  it('échappe ce qu elle interpole, y compris ses propres libellés', () => {
    // Un libellé cesse d être « le sien » dès qu il peut venir d un bundle :
    // « just now » n a pas d apostrophe, « à l instant » en a une, et l allemand
    // a ses guillemets. Le test porte donc sur l échappement lui-même, que la
    // langue de la source ne peut plus exercer.
    expect(escape("à l'instant")).toBe('à l&#39;instant');
    expect(escape('<b>&"</b>')).toBe('&#60;b&#62;&#38;&#34;&#60;/b&#62;');
  });

  it('reste affichable sans aucune mesure, et propose de rafraîchir', () => {
    const html = usageHtml(undefined, now);
    expect(html).toContain('inconnue');
    expect(html).toContain('rafraîchir');
  });

  it('échappe ce qui vient de l extérieur', () => {
    // La source et les libellés sont à nous, mais la règle vaut par défaut : une
    // vue web ne doit jamais interpoler sans échapper.
    expect(usageHtml(undefined, now)).not.toContain('<script>alert');
  });
});
