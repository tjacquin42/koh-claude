import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReentrantGuard } from '../src/lib/reentrant-guard';

// Un délai franchement plus grand que n'importe quel test normal (qui se
// règle en quelques microtasks) : la branche timeout ne doit jamais se
// déclencher dans ces tests-là, seuls ceux qui la ciblent explicitement
// avancent l'horloge simulée jusque-là.
const NEVER_TIMES_OUT_MS = 1_000_000;

describe('ReentrantGuard', () => {
  it('ignore un déclenchement pendant qu un appel est déjà en vol', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    let inFlight = false;
    let concurrentCalls = 0;
    const onError = () => undefined;

    const first = guard.run(async () => {
      inFlight = true;
      // Un second run() déclenché pendant que le premier est en vol doit être un no-op.
      await guard.run(async () => {
        concurrentCalls += 1;
      }, onError);
      await Promise.resolve();
      inFlight = false;
    }, onError);

    expect(inFlight).toBe(true);
    await first;

    expect(concurrentCalls).toBe(0);
    expect(guard.running).toBe(false);
  });

  it('exécute normalement quand aucun appel n est en vol', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    let calls = 0;
    await guard.run(async () => {
      calls += 1;
    }, () => undefined);
    expect(calls).toBe(1);
    expect(guard.running).toBe(false);
  });

  it('retombe sur running=false après une exécution, permettant le prochain appel', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    let calls = 0;
    await guard.run(async () => {
      calls += 1;
    }, () => undefined);
    await guard.run(async () => {
      calls += 1;
    }, () => undefined);
    expect(calls).toBe(2);
  });

  it('avale une erreur via onError plutôt que de la laisser remonter en rejet non géré', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    const errors: unknown[] = [];
    const boom = new Error('panne');

    await expect(
      guard.run(async () => {
        throw boom;
      }, (err) => errors.push(err)),
    ).resolves.toBeUndefined();

    expect(errors).toEqual([boom]);
  });

  it('remet running à false après une erreur : l appel suivant n est pas bloqué', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    await guard.run(async () => {
      throw new Error('panne');
    }, () => undefined);

    expect(guard.running).toBe(false);

    let ranAfter = false;
    await guard.run(async () => {
      ranAfter = true;
    }, () => undefined);
    expect(ranAfter).toBe(true);
  });

  it('un déclenchement pendant une exécution en vol ne fait pas perdre le travail : rejouable ensuite', async () => {
    const guard = new ReentrantGuard(NEVER_TIMES_OUT_MS);
    const done: string[] = [];

    let releaseFirst: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = guard.run(async () => {
      await blocker;
      done.push('premier');
    }, () => undefined);

    // Le second est un no-op immédiat pendant que le premier est en vol.
    await guard.run(async () => {
      done.push('second');
    }, () => undefined);
    expect(done).toEqual([]);

    releaseFirst();
    await first;
    expect(done).toEqual(['premier']);

    // Un nouvel appel après la fin du premier s exécute normalement.
    await guard.run(async () => {
      done.push('troisième');
    }, () => undefined);
    expect(done).toEqual(['premier', 'troisième']);
  });

  describe('borne dans le temps (N2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('relâche la garde et signale une fois si fn ne se règle jamais avant le délai', async () => {
      vi.useFakeTimers();
      const guard = new ReentrantGuard(1000);
      const errors: unknown[] = [];

      // Ne se règle jamais (ni résolution ni rejet) : simule un tick bloqué.
      const runPromise = guard.run(() => new Promise<void>(() => undefined), (err) => errors.push(err));

      await vi.advanceTimersByTimeAsync(999);
      expect(guard.running).toBe(true);
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2);
      await runPromise;

      expect(guard.running).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
    });

    it('deux passages concurrents après un dépassement de délai : accepté, comme deux fenêtres qui drainent en même temps', async () => {
      vi.useFakeTimers();
      const guard = new ReentrantGuard(1000);
      const order: string[] = [];

      void guard.run(() => new Promise<void>(() => undefined), () => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(guard.running).toBe(false);

      // La garde ne bloque plus : un nouvel appel s'exécute pendant que le
      // premier (abandonné, jamais annulé) est toujours virtuellement en vol.
      await guard.run(async () => {
        order.push('second appel, après le délai du premier');
      }, () => undefined);

      expect(order).toEqual(['second appel, après le délai du premier']);
    });

    it("l'exécution abandonnée qui finit par rejeter plus tard n'est pas un rejet non géré : onError la rattrape aussi", async () => {
      vi.useFakeTimers();
      const guard = new ReentrantGuard(1000);
      const errors: unknown[] = [];
      const lateBoom = new Error('panne tardive');

      let rejectLate: (err: unknown) => void = () => undefined;
      const neverSoon = new Promise<void>((_resolve, reject) => {
        rejectLate = reject;
      });

      const runPromise = guard.run(() => neverSoon, (err) => errors.push(err));
      await vi.advanceTimersByTimeAsync(1000);
      await runPromise;

      expect(errors).toEqual([expect.any(Error)]); // le signalement du délai dépassé

      rejectLate(lateBoom);
      // Laisse le .then attaché à l'exécution abandonnée se régler.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(errors).toContain(lateBoom);
      expect(errors).toHaveLength(2);
    });

    it("l'exécution abandonnée qui finit par réussir plus tard ne déclenche pas de second signalement", async () => {
      vi.useFakeTimers();
      const guard = new ReentrantGuard(1000);
      const errors: unknown[] = [];

      let resolveLate: () => void = () => undefined;
      const neverSoon = new Promise<void>((resolve) => {
        resolveLate = resolve;
      });

      const runPromise = guard.run(() => neverSoon, (err) => errors.push(err));
      await vi.advanceTimersByTimeAsync(1000);
      await runPromise;
      expect(errors).toHaveLength(1); // le signalement du délai dépassé

      resolveLate();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(errors).toHaveLength(1); // toujours un seul, la réussite tardive ne signale rien
    });

    it('ne déclenche pas le délai quand fn se règle largement avant', async () => {
      vi.useFakeTimers();
      const guard = new ReentrantGuard(1000);
      const errors: unknown[] = [];
      let calls = 0;

      await guard.run(async () => {
        calls += 1;
      }, (err) => errors.push(err));

      await vi.advanceTimersByTimeAsync(1000);

      expect(calls).toBe(1);
      expect(errors).toHaveLength(0);
      expect(guard.running).toBe(false);
    });
  });
});
