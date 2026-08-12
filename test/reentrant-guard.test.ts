import { describe, expect, it } from 'vitest';
import { ReentrantGuard } from '../src/lib/reentrant-guard';

describe('ReentrantGuard', () => {
  it('ignore un déclenchement pendant qu un appel est déjà en vol', async () => {
    const guard = new ReentrantGuard();
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
    const guard = new ReentrantGuard();
    let calls = 0;
    await guard.run(async () => {
      calls += 1;
    }, () => undefined);
    expect(calls).toBe(1);
    expect(guard.running).toBe(false);
  });

  it('retombe sur running=false après une exécution, permettant le prochain appel', async () => {
    const guard = new ReentrantGuard();
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
    const guard = new ReentrantGuard();
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
    const guard = new ReentrantGuard();
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
    const guard = new ReentrantGuard();
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
});
