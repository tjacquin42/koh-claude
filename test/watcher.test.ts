import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions, writeSession } from '../src/spool/persist';
import { appendLocalEvent, drain, MAX_CONSECUTIVE_DEFERRALS, SpoolWatcher } from '../src/spool/watcher';

// `node:fs/promises` est un module natif : ses exports ne sont pas
// redéfinissables via vi.spyOn. On le mocke entièrement, en délégant à
// l'implémentation réelle sauf quand un test arme l'un des overrides. Un
// override qui retourne `undefined` laisse passer vers l'implémentation réelle
// (même convention pour les trois) : c'est ce qui permet à un test de ne
// truquer qu'un chemin précis (ex : un seul id de session) sans devoir
// réimplémenter le reste.
const { unlinkOverride, writeFileOverride, readFileOverride } = vi.hoisted(() => ({
  unlinkOverride: { current: undefined as ((path: string) => Promise<void>) | undefined },
  writeFileOverride: {
    current: undefined as ((path: string, data: string) => Promise<void> | undefined) | undefined,
  },
  readFileOverride: { current: undefined as ((path: string) => Promise<string> | undefined) | undefined },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: (path: Parameters<typeof actual.unlink>[0]) =>
      unlinkOverride.current !== undefined ? unlinkOverride.current(String(path)) : actual.unlink(path),
    writeFile: (
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      const override = writeFileOverride.current?.(String(path), String(data));
      return override !== undefined ? override : actual.writeFile(path, data, options);
    },
    readFile: (
      path: Parameters<typeof actual.readFile>[0],
      encoding?: Parameters<typeof actual.readFile>[1],
    ) => {
      const override = readFileOverride.current?.(String(path));
      return override !== undefined ? override : actual.readFile(path, encoding);
    },
  };
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

let home: string;
let dirs: SpoolDirs;

// Horloge de test, sans rapport avec Date.now() : les `at` des événements
// restent de petits entiers lisibles (1, 2, 3…), et NOW leur est largement
// postérieur tout en restant à des années-lumière du seuil de purge de 24 h
// (SESSION_PURGE_MS = 86 400 000 ms) — aucun de ces tests ne doit purger une
// session par accident.
const NOW = 1_000_000;

async function dropEvent(name: string, body: unknown): Promise<void> {
  await writeFile(join(dirs.events, name), JSON.stringify(body), 'utf8');
}

const hook = (event: string, at: number, extra: Record<string, unknown> = {}) => ({
  event, at, entrypoint: 'cli', termProgram: '',
  payload: { session_id: 's1', cwd: '/Users/jack/DEV/pity-tidy', ...extra },
});

const session = (id: string, lastEventAt: number) => ({
  id, cwd: '/x', project: 'x', origin: 'vscode' as const,
  status: 'idle' as const, toolCount: 0, lastEventAt,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  unlinkOverride.current = undefined;
  writeFileOverride.current = undefined;
  readFileOverride.current = undefined;
});

describe('drain', () => {
  it('applique les événements, écrit l état, puis supprime le fichier', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await dropEvent('2-1-PreToolUse.json', hook('PreToolUse', 2, { tool_name: 'Bash' }));
    const res = await drain(dirs, NOW);
    expect(res.applied).toBe(2);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('running');
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('traite les fichiers dans l ordre de leur nom', async () => {
    await dropEvent('20-1-Stop.json', hook('Stop', 20));
    await dropEvent('10-1-UserPromptSubmit.json', hook('UserPromptSubmit', 10));
    await drain(dirs, NOW);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('done_unseen');
  });

  it('met de côté un fichier illisible sans bloquer les autres', async () => {
    await writeFile(join(dirs.events, '1-1-Casse.json'), '{ pas du json', 'utf8');
    await dropEvent('2-1-SessionStart.json', hook('SessionStart', 2));
    const res = await drain(dirs, NOW);
    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(1);
    expect(readdirSync(dirs.rejected)).toHaveLength(1);
  });

  it('retire la session sur SessionEnd', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await drain(dirs, NOW);
    await dropEvent('2-1-SessionEnd.json', hook('SessionEnd', 2));
    await drain(dirs, NOW);
    expect((await readSessions(dirs)).size).toBe(0);
  });

  it('ignore le fichier temporaire du bridge en cours d écriture', async () => {
    await writeFile(join(dirs.events, '.tmp-1-Stop'), '{"incomp', 'utf8');
    const res = await drain(dirs, NOW);
    expect(res.applied).toBe(0);
    expect(res.rejected).toBe(0);
  });

  it('appendLocalEvent produit un événement que drain sait lire', async () => {
    await dropEvent('1-1-Stop.json', hook('Stop', 1));
    await drain(dirs, NOW);
    await appendLocalEvent(dirs, { event: 'Ack', sessionId: 's1', cwd: '/Users/jack/DEV/pity-tidy' });
    await drain(dirs, NOW);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('idle');
  });

  it('appendLocalEvent concurrents (sans attente entre eux) produisent chacun un fichier distinct', async () => {
    // process.pid est constant sur toute la durée de vie du process de l'extension :
    // deux appels concurrents portant le même event ne doivent pas se marcher dessus.
    const calls = [
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's1', cwd: '/Users/jack/DEV/pity-tidy' }),
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's2', cwd: '/Users/jack/DEV/pity-tidy' }),
      appendLocalEvent(dirs, { event: 'Ack', sessionId: 's3', cwd: '/Users/jack/DEV/pity-tidy' }),
    ];
    await Promise.all(calls);

    const files = readdirSync(dirs.events).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(3);

    const sessionIds = new Set<string>();
    for (const name of files) {
      const raw = await readFile(join(dirs.events, name), 'utf8');
      const parsed = JSON.parse(raw) as { payload: { session_id: string } };
      sessionIds.add(parsed.payload.session_id);
    }
    expect(sessionIds).toEqual(new Set(['s1', 's2', 's3']));
  });
});

describe('drain — pannes de suppression', () => {
  it('ignore silencieusement un unlink en échec ENOENT (déjà supprimé par une autre fenêtre)', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    unlinkOverride.current = () => Promise.reject(err);

    const res = await drain(dirs, NOW);
    unlinkOverride.current = undefined;

    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(0);
    expect(readdirSync(dirs.rejected)).toHaveLength(0);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
  });

  it('met de côté un événement dont la suppression échoue pour une vraie raison, pour éviter un double comptage', async () => {
    await dropEvent('1-1-PostToolUse.json', hook('PostToolUse', 1, { tool_name: 'Bash' }));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    unlinkOverride.current = () => Promise.reject(err);

    const res = await drain(dirs, NOW);
    unlinkOverride.current = undefined;

    expect(res.applied).toBe(1);
    expect(res.rejected).toBe(1);
    expect(readdirSync(dirs.rejected).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    // Le fichier écarté ne peut plus être retraité : un second drain ne double
    // pas le compteur d'outils, qui est cumulatif.
    const res2 = await drain(dirs, NOW);
    expect(res2.applied).toBe(0);
    expect((await readSessions(dirs)).get('s1')?.toolCount).toBe(1);
  });
});

describe('drain — pannes d écriture (C2)', () => {
  it('un échec d écriture ne fait pas lever drain() : l événement est différé, pas perdu, pas classé invalide', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    writeFileOverride.current = () => Promise.reject(err);

    const res = await drain(dirs, NOW);
    writeFileOverride.current = undefined;

    expect(res.applied).toBe(0);
    expect(res.deferred).toBe(1);
    expect(res.rejected).toBe(0);
    // Ni supprimé, ni écarté vers rejected/ : il sera retenté au prochain drain.
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(dirs.rejected)).toHaveLength(0);
    expect((await readSessions(dirs)).size).toBe(0);
  });

  it('un événement dont l écriture échoue ne bloque pas les événements suivants du même drain', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1, { session_id: 's-panne' }));
    await dropEvent('2-1-SessionStart.json', hook('SessionStart', 1, { session_id: 's-ok' }));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    // Ne truque que l'écriture de la session en panne ; laisse l'autre passer.
    writeFileOverride.current = (path) => (path.includes('s-panne') ? Promise.reject(err) : undefined);

    const res = await drain(dirs, NOW);
    writeFileOverride.current = undefined;

    expect(res.applied).toBe(1);
    expect(res.deferred).toBe(1);
    const sessions = await readSessions(dirs);
    expect(sessions.has('s-ok')).toBe(true);
    expect(sessions.has('s-panne')).toBe(false);
    // Le fichier de l'événement en échec reste en place ; celui qui a réussi est parti.
    const remaining = readdirSync(dirs.events).filter((f) => f.endsWith('.json'));
    expect(remaining).toEqual(['1-1-SessionStart.json']);
  });

  it('un échec transitoire se résorbe tout seul : le drain suivant, sans la panne, applique l événement laissé de côté', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    writeFileOverride.current = () => Promise.reject(err);
    const first = await drain(dirs, NOW);
    expect(first.deferred).toBe(1);

    writeFileOverride.current = undefined;
    const second = await drain(dirs, NOW);

    expect(second.applied).toBe(1);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
  });
});

describe('drain — échec permanent (N3)', () => {
  it("après MAX_CONSECUTIVE_DEFERRALS échecs consécutifs, l'événement est écarté vers rejected/ avec sa raison, et signalé", async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    // Seule sessions/ est en panne (comme sessions/ passé en 0555 dans la
    // revue) : l'écriture de la raison dans rejected/ doit encore réussir.
    writeFileOverride.current = (path) => (path.includes(dirs.sessions) ? Promise.reject(err) : undefined);

    // Une carte partagée entre plusieurs appels : simule la même fenêtre qui
    // retente à chaque tick, comme le fait SpoolWatcher via son propre champ.
    const failureCounts = new Map<string, number>();
    let res;
    for (let i = 0; i < MAX_CONSECUTIVE_DEFERRALS; i += 1) {
      res = await drain(dirs, NOW, failureCounts);
    }
    writeFileOverride.current = undefined;

    expect(res?.deferred).toBe(0);
    expect(res?.rejectedPermanently).toEqual(['1-1-SessionStart.json']);
    expect(res?.rejected).toBe(1);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    const rejectedFiles = readdirSync(dirs.rejected);
    expect(rejectedFiles).toContain('1-1-SessionStart.json');
    expect(rejectedFiles).toContain('1-1-SessionStart.json.reason.txt');
    const reason = await readFile(join(dirs.rejected, '1-1-SessionStart.json.reason.txt'), 'utf8');
    expect(reason).toContain('EACCES');

    expect((await readSessions(dirs)).size).toBe(0);
  });

  it("sous MAX_CONSECUTIVE_DEFERRALS, l'événement reste différé et retente au lieu d'être écarté", async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    writeFileOverride.current = () => Promise.reject(err);

    const failureCounts = new Map<string, number>();
    let res;
    for (let i = 0; i < MAX_CONSECUTIVE_DEFERRALS - 1; i += 1) {
      res = await drain(dirs, NOW, failureCounts);
    }
    writeFileOverride.current = undefined;

    expect(res?.rejectedPermanently).toEqual([]);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(dirs.rejected).filter((f) => f.endsWith('.json') || f.endsWith('.txt'))).toHaveLength(0);
  });

  it('un succès réinitialise le compteur : il ne suffit pas de deux échecs répartis avant et après une réussite', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const failureCounts = new Map<string, number>();

    writeFileOverride.current = () => Promise.reject(err);
    await drain(dirs, NOW, failureCounts); // 1er échec
    expect(failureCounts.get('1-1-SessionStart.json')).toBe(1);

    writeFileOverride.current = undefined;
    const success = await drain(dirs, NOW, failureCounts); // réussit : compteur nettoyé
    expect(success.applied).toBe(1);
    expect(failureCounts.has('1-1-SessionStart.json')).toBe(false);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
  });

  it('SpoolWatcher.tick() signale une fois via onError quand un événement est écarté définitivement', async () => {
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    writeFileOverride.current = () => Promise.reject(err);

    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange, onError, () => NOW);
    const internal = watcher as unknown as { tick: () => Promise<void> };

    for (let i = 0; i < MAX_CONSECUTIVE_DEFERRALS; i += 1) {
      await internal.tick();
    }
    writeFileOverride.current = undefined;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(readdirSync(dirs.rejected)).toContain('1-1-SessionStart.json');
  });
});

describe('drain — purge des sessions mortes (C1)', () => {
  it('purge une session dont lastEventAt dépasse 24h et le rapporte dans purged', async () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60_000;
    await writeSession(dirs, session('morte', 0));
    const res = await drain(dirs, TWENTY_FIVE_HOURS);
    expect(res.purged).toEqual(['morte']);
    expect((await readSessions(dirs)).has('morte')).toBe(false);
  });

  it('ne purge pas une session récente', async () => {
    await writeSession(dirs, session('fraiche', NOW));
    const res = await drain(dirs, NOW + 1000);
    expect(res.purged).toEqual([]);
    expect((await readSessions(dirs)).has('fraiche')).toBe(true);
  });

  it('purge même quand il n y a aucun événement à traiter', async () => {
    const TWENTY_FIVE_HOURS = 25 * 60 * 60_000;
    await writeSession(dirs, session('morte', 0));
    const res = await drain(dirs, TWENTY_FIVE_HOURS);
    expect(res.applied).toBe(0);
    expect(res.purged).toEqual(['morte']);
  });
});

describe('drain — convergence entre fenêtres (I1)', () => {
  it("une fenêtre qui écrit depuis une base périmée ne ressuscite pas une session supprimée entre-temps par une autre", async () => {
    // Établit s1 en « terminé non lu », comme reduce le prévoit.
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await dropEvent('2-1-Stop.json', hook('Stop', 2));
    await drain(dirs, NOW);
    expect((await readSessions(dirs)).get('s1')?.status).toBe('done_unseen');

    // Fenêtre A : un Ack en attente de traitement. On intercepte juste après
    // qu'elle a lu le CONTENU de ce fichier — le même point d'entrelacement
    // qu'un `await` réel entre deux process. Ne se déclenche qu'une fois : la
    // fenêtre B doit pouvoir relire ce même fichier sans se bloquer dessus.
    await dropEvent('3-1-Ack.json', hook('Ack', 3));
    let triggered = false;
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let reachedGate: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    readFileOverride.current = (path) => {
      if (triggered || !path.endsWith('3-1-Ack.json')) return undefined;
      triggered = true;
      const real = readFile(path, 'utf8');
      reachedGate();
      return gate.then(() => real);
    };

    const drainA = drain(dirs, NOW);
    await reached;

    // Fenêtre B : dépose le SessionEnd et vide tout le spool pendant que A est
    // en pause. B voit aussi le fichier Ack (pas encore supprimé par A) : ça
    // n'a pas d'importance, sa réduction est pure et B finit par retirer s1.
    await dropEvent('4-1-SessionEnd.json', hook('SessionEnd', 4));
    const resB = await drain(dirs, NOW);
    expect(resB.applied).toBeGreaterThanOrEqual(1);
    expect((await readSessions(dirs)).size).toBe(0);

    releaseA();
    const resA = await drainA;
    readFileOverride.current = undefined;

    expect(resA.applied).toBe(1);
    // Le SessionEnd a été appliqué et son fichier supprimé par B : la session
    // ne doit pas revenir parce que A écrit depuis une base lue avant B.
    expect((await readSessions(dirs)).size).toBe(0);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

describe('SpoolWatcher', () => {
  it('start() tolère un dossier events absent, sans perdre la capacité de consommer ce qui arrive ensuite', async () => {
    const missingDirs = spoolDirs(join(home, 'pas-encore-cree'));
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpoolWatcher(missingDirs, onChange, onError, () => NOW);

    expect(() => watcher.start()).not.toThrow();

    // Le dossier apparaît après coup (ex : ensureDirs appelé ailleurs), puis un événement y est déposé.
    await ensureDirs(missingDirs);
    await writeFile(
      join(missingDirs.events, '1-1-SessionStart.json'),
      JSON.stringify(hook('SessionStart', 1)),
      'utf8',
    );

    // Simule le tour de filet suivant sans attendre les 5 secondes réelles.
    await (watcher as unknown as { tick: () => Promise<void> }).tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await readSessions(missingDirs)).get('s1')?.startedAt).toBe(1);
    expect(onError).not.toHaveBeenCalled();

    watcher.stop();
  });

  it('stop() ferme le FSWatcher et efface le minuteur de secours : plus aucun onChange après', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange, onError, () => NOW);
    watcher.start();

    try {
      const internal = watcher as unknown as {
        watcher?: { close: () => void };
        timer?: NodeJS.Timeout;
      };
      expect(internal.watcher).toBeDefined();
      expect(internal.timer).toBeDefined();
      const closeSpy = vi.spyOn(internal.watcher as { close: () => void }, 'close');

      // Avant stop() : un événement déposé est bien détecté et consommé.
      await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
      await waitFor(() => onChange.mock.calls.length > 0);
      expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);

      watcher.stop();

      expect(closeSpy).toHaveBeenCalledOnce();
      expect(internal.watcher).toBeUndefined();
      expect(internal.timer).toBeUndefined();

      const callsAtStop = onChange.mock.calls.length;
      await dropEvent('2-1-Stop.json', hook('Stop', 2));
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(onChange.mock.calls.length).toBe(callsAtStop);
      // Le fichier déposé après stop() n'a pas été drainé.
      expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  it('la garde de non-réentrance ne fait perdre aucun fichier : un événement déposé pendant une vidange finit consommé', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange, onError, () => NOW);
    const internal = watcher as unknown as { guard: { running: boolean }; tick: () => Promise<void> };

    // Simule une vidange déjà en cours.
    internal.guard.running = true;
    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));

    // Un déclenchement qui arrive pendant la vidange est un no-op : rien n'est perdu.
    await internal.tick();
    expect(onChange).not.toHaveBeenCalled();
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    // La vidange en cours se termine ; le prochain déclenchement retrouve le fichier.
    internal.guard.running = false;
    await internal.tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await readSessions(dirs)).get('s1')?.startedAt).toBe(1);
    expect(readdirSync(dirs.events).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('si onChange lève, tick() ne rejette pas : onError est appelé et la garde retombe, le tick suivant fonctionne', async () => {
    const onChange = vi.fn(() => {
      throw new Error('bug dans onChange');
    });
    const onError = vi.fn();
    const watcher = new SpoolWatcher(dirs, onChange, onError, () => NOW);
    const internal = watcher as unknown as { guard: { running: boolean }; tick: () => Promise<void> };

    await dropEvent('1-1-SessionStart.json', hook('SessionStart', 1));
    await expect(internal.tick()).resolves.toBeUndefined();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(internal.guard.running).toBe(false);

    // Le tick suivant n'est pas resté bloqué par l'échec du précédent.
    onChange.mockReset();
    await dropEvent('2-1-Stop.json', hook('Stop', 2));
    await internal.tick();
    expect((await readSessions(dirs)).get('s1')?.status).toBe('done_unseen');
  });
});
