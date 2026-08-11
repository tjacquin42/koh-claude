import { describe, expect, it } from 'vitest';
import { STALE_IN_FLIGHT_MS, STALE_SILENT_MS, withStaleness } from '../src/store/staleness';
import type { Session } from '../src/events/types';

const base: Session = {
  id: 's', cwd: '/x', project: 'x', origin: 'vscode',
  status: 'running', toolCount: 0, lastEventAt: 0,
};

describe('withStaleness', () => {
  it('périme une session en cours et silencieuse', () => {
    expect(withStaleness(base, STALE_SILENT_MS + 1).status).toBe('stale');
  });

  it('ne périme pas avant le délai', () => {
    expect(withStaleness(base, STALE_SILENT_MS - 1).status).toBe('running');
  });

  it('suspend la péremption pendant un outil en vol', () => {
    const inFlight: Session = { ...base, inFlightSince: 0 };
    expect(withStaleness(inFlight, STALE_SILENT_MS + 1).status).toBe('running');
  });

  it('périme quand même au-delà du plafond', () => {
    const inFlight: Session = { ...base, inFlightSince: 0 };
    expect(withStaleness(inFlight, STALE_IN_FLIGHT_MS + 1).status).toBe('stale');
  });

  it('ne touche pas aux autres statuts', () => {
    for (const status of ['waiting', 'done_unseen', 'idle', 'stale'] as const) {
      expect(withStaleness({ ...base, status }, STALE_IN_FLIGHT_MS * 10).status).toBe(status);
    }
  });
});
