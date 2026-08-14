import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseUsage } from '../src/usage/model';
import { forgetAttempts, readUsage, refreshFromApi, REFRESH_AFTER_MS } from '../src/usage/reader';
import { accessTokenOf } from '../src/usage/oauth';
import { usageColor, usageLabel, usageTooltip } from '../src/ui/usage-label';

const reading = (raw: unknown, at = 0) => ({ usage: parseUsage(raw)!, source: 'statusline' as const, at });

const REAL = {
  rate_limits: {
    five_hour: { used_percentage: 78, resets_at: 1786297800 },
    seven_day: { used_percentage: 32, resets_at: 1786712400 },
  },
};

describe('parseUsage', () => {
  it('lit la forme réellement observée dans la statusline', () => {
    expect(parseUsage(REAL)).toEqual({
      fiveHour: { percent: 78, resetsAt: 1786297800 },
      sevenDay: { percent: 32, resetsAt: 1786712400 },
    });
  });

  it('accepte une fenêtre sans échéance — le pourcentage vaut à lui seul', () => {
    expect(parseUsage({ rate_limits: { five_hour: { used_percentage: 5 } } })).toEqual({
      fiveHour: { percent: 5, resetsAt: undefined },
      sevenDay: undefined,
    });
  });

  it('écarte un pourcentage hors bornes plutôt que d afficher une jauge absurde', () => {
    for (const bad of [-3, 101, Number.NaN, Number.POSITIVE_INFINITY, '78']) {
      expect(parseUsage({ rate_limits: { five_hour: { used_percentage: bad } } })).toBeUndefined();
    }
  });

  it('garde les bornes exactes', () => {
    expect(parseUsage({ rate_limits: { five_hour: { used_percentage: 0 } } })?.fiveHour?.percent).toBe(0);
    expect(parseUsage({ rate_limits: { five_hour: { used_percentage: 100 } } })?.fiveHour?.percent).toBe(100);
  });

  it('écarte une échéance nulle ou négative sans perdre le pourcentage', () => {
    const u = parseUsage({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 0 } } });
    expect(u?.fiveHour).toEqual({ percent: 10, resetsAt: undefined });
  });

  it('rend undefined quand rien n est exploitable — pas une mesure à zéro', () => {
    expect(parseUsage({})).toBeUndefined();
    expect(parseUsage({ rate_limits: {} })).toBeUndefined();
    expect(parseUsage({ rate_limits: 'nope' })).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage('{}')).toBeUndefined();
  });
});

describe('usageLabel', () => {
  it('résume les deux fenêtres', () => {
    expect(usageLabel(reading(REAL))).toBe('5 h 78 % · 7 j 32 %');
  });

  it('n affiche que la fenêtre mesurée quand l autre manque', () => {
    expect(usageLabel(reading({ rate_limits: { seven_day: { used_percentage: 4 } } }))).toBe('7 j 4 %');
  });

  it('arrondit plutôt que d afficher une décimale de pourcentage', () => {
    expect(usageLabel(reading({ rate_limits: { five_hour: { used_percentage: 78.4 } } }))).toBe('5 h 78 %');
  });
});

describe('usageColor', () => {
  const at = (five: number, seven: number) =>
    parseUsage({ rate_limits: { five_hour: { used_percentage: five }, seven_day: { used_percentage: seven } } })!;

  it('reste sobre en dessous du seuil', () => {
    expect(usageColor(at(10, 20))).toBeUndefined();
  });

  it('suit la fenêtre la plus consommée, pas leur moyenne', () => {
    // Une moyenne à 46 % ne dirait rien ; c est le 92 % qui doit se voir.
    expect(usageColor(at(92, 1))).toBe('charts.red');
    expect(usageColor(at(1, 80))).toBe('charts.yellow');
  });

  it('bascule exactement aux seuils', () => {
    expect(usageColor(at(74, 0))).toBeUndefined();
    expect(usageColor(at(75, 0))).toBe('charts.yellow');
    expect(usageColor(at(89, 0))).toBe('charts.yellow');
    expect(usageColor(at(90, 0))).toBe('charts.red');
  });
});

describe('usageTooltip', () => {

  it('convertit l échéance en secondes, pas en millisecondes', () => {
    // 1786297800 s vaut 2026-08-14T18:30:00Z ; une lecture en millisecondes
    // placerait la réinitialisation en 1970 et afficherait « réinitialisée ».
    const now = 1786297800 * 1000 - 2 * 3600 * 1000;
    expect(usageTooltip(reading(REAL, now), now)).toContain('dans 2 h');
  });

  it('dit qu une fenêtre échue est réinitialisée, jamais un délai négatif', () => {
    const now = 1786297800 * 1000 + 60_000;
    const line = usageTooltip(reading({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1786297800 } } }, now), now);
    expect(line).toContain('réinitialisée');
    expect(line).not.toContain('-');
  });

  it('dit d où vient la mesure et depuis quand', () => {
    const now = 600_000;
    expect(usageTooltip({ usage: parseUsage(REAL)!, source: 'api', at: now - 120_000 }, now)).toContain(
      'Source : Anthropic, il y a 2 min',
    );
    expect(usageTooltip({ usage: parseUsage(REAL)!, source: 'statusline', at: now }, now)).toContain(
      'Source : statusline Claude Code',
    );
  });
});

// La forme réellement rendue par le point d'usage d'Anthropic, telle qu'on la
// trouve mise en cache sur le disque : `utilization` plutôt que
// `used_percentage`, et une date ISO plutôt que des secondes Unix.
const API = {
  five_hour: { utilization: 13, resets_at: '2026-08-14T20:10:00.000725+00:00', limit_dollars: null },
  seven_day: { utilization: 3, resets_at: '2026-08-21T13:00:00.000747+00:00' },
  seven_day_opus: null,
};

describe('parseUsage — les deux vocabulaires', () => {
  it('lit `utilization` comme `used_percentage`, et une date ISO comme des secondes', () => {
    expect(parseUsage(API)).toEqual({
      fiveHour: { percent: 13, resetsAt: Math.floor(Date.parse('2026-08-14T20:10:00.000725+00:00') / 1000) },
      sevenDay: { percent: 3, resetsAt: Math.floor(Date.parse('2026-08-21T13:00:00.000747+00:00') / 1000) },
    });
  });

  it('ramène l échéance à des SECONDES, jamais des millisecondes', () => {
    // Une date ISO lue en millisecondes ferait un `resetsAt` mille fois trop
    // grand, et l infobulle annoncerait une réinitialisation dans 500 000 heures.
    const u = parseUsage(API)!;
    expect(u.fiveHour!.resetsAt).toBeLessThan(2_000_000_000);
  });

  it('ignore une date ISO illisible sans perdre le pourcentage', () => {
    expect(parseUsage({ five_hour: { utilization: 7, resets_at: 'pas une date' } })?.fiveHour).toEqual({
      percent: 7,
      resetsAt: undefined,
    });
  });
});

describe('readUsage', () => {
  const home = async (): Promise<string> => mkdtemp(join(tmpdir(), 'koh-usage-'));

  it('lit le relevé mis en cache par l appel à l API', async () => {
    const h = await home();
    await writeFile(join(h, 'usage.json'), JSON.stringify(API), 'utf8');
    const r = await readUsage(h);
    expect(r?.usage.fiveHour?.percent).toBe(13);
    expect(r?.source).toBe('api');
  });

  it('lit aussi ce que le pont de statusline a capté', async () => {
    const h = await home();
    await writeFile(join(h, 'status.json'), JSON.stringify(REAL), 'utf8');
    const r = await readUsage(h);
    expect(r?.usage.fiveHour?.percent).toBe(78);
    expect(r?.source).toBe('statusline');
  });

  it('garde la plus FRAÎCHE des deux, jamais une priorité fixe', async () => {
    const h = await home();
    await writeFile(join(h, 'usage.json'), JSON.stringify(API), 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(h, 'status.json'), JSON.stringify(REAL), 'utf8');
    expect((await readUsage(h))?.source).toBe('statusline');

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(h, 'usage.json'), JSON.stringify(API), 'utf8');
    expect((await readUsage(h))?.source).toBe('api');
  });

  it('traite l absence et l illisible comme « pas de mesure », jamais comme une erreur', async () => {
    const h = await home();
    expect(await readUsage(h)).toBeUndefined();
    await writeFile(join(h, 'status.json'), 'pas du JSON', 'utf8');
    expect(await readUsage(h)).toBeUndefined();
  });
});

describe('accessTokenOf', () => {
  it('extrait le jeton du JSON du trousseau', () => {
    expect(accessTokenOf(JSON.stringify({ claudeAiOauth: { accessToken: 'abc' } }))).toBe('abc');
  });

  it('rend undefined sur tout ce qui n est pas la forme attendue', () => {
    expect(accessTokenOf('pas du JSON')).toBeUndefined();
    expect(accessTokenOf('{}')).toBeUndefined();
    expect(accessTokenOf(JSON.stringify({ claudeAiOauth: {} }))).toBeUndefined();
    expect(accessTokenOf(JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeUndefined();
    expect(accessTokenOf(JSON.stringify({ claudeAiOauth: { accessToken: 42 } }))).toBeUndefined();
    expect(accessTokenOf('[]')).toBeUndefined();
  });
});


describe('refreshFromApi — le rythme', () => {
  const deps = (opts: { token?: string; payload?: unknown; now?: () => number } = {}) => {
    const calls = { token: 0, fetch: 0 };
    return {
      calls,
      deps: {
        readToken: async () => {
          calls.token += 1;
          return opts.token;
        },
        fetch: async () => {
          calls.fetch += 1;
          return opts.payload;
        },
        now: opts.now ?? (() => Date.now()),
      },
    };
  };

  beforeEach(() => forgetAttempts());

  it('interroge l API et met le relevé en cache', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    const { deps: d, calls } = deps({ token: 'jeton', payload: API });
    const r = await refreshFromApi(h, false, d);
    expect(calls.fetch).toBe(1);
    expect(r?.usage.fiveHour?.percent).toBe(13);
    // Et le relevé est relisible par une autre fenêtre.
    expect((await readUsage(h))?.source).toBe('api');
  });

  it('ne rappelle pas l API tant que le délai n est pas écoulé', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    const { deps: d, calls } = deps({ token: 'jeton', payload: API });
    await refreshFromApi(h, false, d);
    await refreshFromApi(h, false, d);
    await refreshFromApi(h, false, d);
    expect(calls.fetch).toBe(1);
  });

  it('ne se relance pas en boucle quand l accès au trousseau échoue', async () => {
    // Le défaut que ce test garde : un échec n écrit aucun fichier, donc rien
    // qui date. En comptant les succès, le rendu — qui tourne toutes les deux
    // secondes — relancerait `security` et une requête HTTPS à chaque tour.
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    const { deps: d, calls } = deps({ token: undefined });
    for (let i = 0; i < 5; i++) await refreshFromApi(h, false, d);
    expect(calls.token).toBe(1);
    expect(calls.fetch).toBe(0);
  });

  it('ne se relance pas en boucle quand l API répond n importe quoi', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    const { deps: d, calls } = deps({ token: 'jeton', payload: { erreur: 'nope' } });
    for (let i = 0; i < 5; i++) await refreshFromApi(h, false, d);
    expect(calls.fetch).toBe(1);
  });

  it('rappelle l API une fois le délai écoulé', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    // Horloge ancrée sur l heure réelle : le second garde compare `now` à la
    // date d écriture du fichier, qui vient du système de fichiers. Une horloge
    // fictive partant de 1970 rendrait ce cache éternellement « frais ».
    let clock = Date.now();
    const { deps: d, calls } = deps({ token: 'jeton', payload: API, now: () => clock });
    await refreshFromApi(h, false, d);
    clock += REFRESH_AFTER_MS + 1_000;
    await refreshFromApi(h, false, d);
    expect(calls.fetch).toBe(2);
  });

  it('force le rafraîchissement à la demande, sans attendre l échéance', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    const { deps: d, calls } = deps({ token: 'jeton', payload: API });
    await refreshFromApi(h, false, d);
    await refreshFromApi(h, true, d);
    expect(calls.fetch).toBe(2);
  });

  it('garde la mesure précédente quand la nouvelle tentative échoue', async () => {
    const h = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    let clock = Date.now();
    await refreshFromApi(h, false, deps({ token: 'jeton', payload: API, now: () => clock }).deps);
    clock += REFRESH_AFTER_MS + 1_000;
    const r = await refreshFromApi(h, false, deps({ token: undefined, now: () => clock }).deps);
    expect(r?.usage.fiveHour?.percent).toBe(13);
  });
});
