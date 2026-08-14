import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsage } from '../src/usage/model';
import { readUsage } from '../src/usage/reader';
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
    expect(usageTooltip({ usage: parseUsage(REAL)!, source: 'vibe-island', at: now - 120_000 }, now)).toContain(
      'Source : Vibe Island, il y a 2 min',
    );
    expect(usageTooltip({ usage: parseUsage(REAL)!, source: 'statusline', at: now }, now)).toContain(
      'Source : statusline Claude Code',
    );
  });
});

// La forme réellement observée dans ~/.vibe-island/cache/usage-persist.json :
// les mêmes champs, mais à la racine plutôt que sous `rate_limits`.
const ISLAND = {
  provider: 'anthropic',
  windows: [{ kind: 'five_hour', utilization: 5 }],
  five_hour: { used_percentage: 5, resets_at: 1786738200 },
  seven_day: { used_percentage: 3, resets_at: 1787317200 },
};

describe('parseUsage — les deux emboîtements', () => {
  it('lit aussi les fenêtres posées à la racine, comme le cache de Vibe Island', () => {
    expect(parseUsage(ISLAND)).toEqual({
      fiveHour: { percent: 5, resetsAt: 1786738200 },
      sevenDay: { percent: 3, resetsAt: 1787317200 },
    });
  });
});

describe('readUsage', () => {
  const bothIn = async (): Promise<{ home: string; island: string }> => {
    const home = await mkdtemp(join(tmpdir(), 'koh-usage-'));
    return { home, island: join(home, 'island.json') };
  };

  it('lit le fichier déposé par le pont', async () => {
    const { home, island } = await bothIn();
    await writeFile(join(home, 'status.json'), JSON.stringify(REAL), 'utf8');
    const r = await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island });
    expect(r?.usage.fiveHour?.percent).toBe(78);
    expect(r?.source).toBe('statusline');
  });

  it('se rabat sur le cache de Vibe Island quand notre pont n a rien capté', async () => {
    const { home, island } = await bothIn();
    await writeFile(island, JSON.stringify(ISLAND), 'utf8');
    const r = await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island });
    expect(r?.usage.fiveHour?.percent).toBe(5);
    expect(r?.source).toBe('vibe-island');
  });

  it('garde la plus FRAÎCHE des deux, jamais une priorité fixe', async () => {
    const { home, island } = await bothIn();
    // Notre instantané d abord, celui de l île ensuite : c est lui qui gagne.
    await writeFile(join(home, 'status.json'), JSON.stringify(REAL), 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(island, JSON.stringify(ISLAND), 'utf8');
    expect((await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island }))?.source).toBe('vibe-island');

    // Puis l inverse, sur les mêmes fichiers : la préférence suit la date.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(home, 'status.json'), JSON.stringify(REAL), 'utf8');
    expect((await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island }))?.source).toBe('statusline');
  });

  it('traite l absence et l illisible comme « pas de mesure », jamais comme une erreur', async () => {
    const { home, island } = await bothIn();
    expect(await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island })).toBeUndefined();
    await writeFile(join(home, 'status.json'), 'pas du JSON', 'utf8');
    expect(await readUsage(home, { KOH_VIBE_ISLAND_USAGE: island })).toBeUndefined();
  });

  it('ne va jamais chercher le vrai cache de la machine quand le test le redirige', async () => {
    const { home } = await bothIn();
    expect(await readUsage(home, { KOH_VIBE_ISLAND_USAGE: join(home, 'inexistant.json') })).toBeUndefined();
  });
});
