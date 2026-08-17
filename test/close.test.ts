import { describe, expect, it } from 'vitest';
import {
  closeSessionHere,
  needsConfirmation,
  requestCloseSession,
  type CloseHereDeps,
  type RequestCloseDeps,
} from '../src/close/close';
import type { Session } from '../src/events/types';

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  status: 'idle',
  toolCount: 0,
  lastEventAt: 0,
  ...over,
});

interface Calls {
  log: string[];
  confirmed: string[];
  routed: string[];
  forgotten: string[];
  archived: string[];
}

function calls(): Calls {
  return { log: [], confirmed: [], routed: [], forgotten: [], archived: [] };
}

function requestDeps(c: Calls, answer = true): RequestCloseDeps {
  return {
    confirm: async (s: Session) => {
      c.log.push('confirm');
      c.confirmed.push(s.id);
      return answer;
    },
    route: async (s: Session) => {
      c.log.push('route');
      c.routed.push(s.id);
    },
    forget: async (id: string) => {
      c.log.push('forget');
      c.forgotten.push(id);
    },
  };
}

function hereDeps(c: Calls, over: Partial<CloseHereDeps> = {}): CloseHereDeps {
  return {
    read: async () => session(),
    closeTab: async () => {
      c.log.push('closeTab');
      return 'closed' as const;
    },
    archive: async (s: Session) => {
      c.log.push('archive');
      c.archived.push(s.id);
    },
    forget: async (id: string) => {
      c.log.push('forget');
      c.forgotten.push(id);
    },
    ...over,
  };
}

describe('needsConfirmation', () => {
  it('asks before cutting a conversation that is working or waiting', () => {
    expect(needsConfirmation('running')).toBe(true);
    expect(needsConfirmation('waiting')).toBe(true);
  });

  it('does not ask when nothing is interrupted', () => {
    expect(needsConfirmation('done_unseen')).toBe(false);
    expect(needsConfirmation('idle')).toBe(false);
    expect(needsConfirmation('stale')).toBe(false);
  });
});

describe('requestCloseSession', () => {
  it('only forgets a conversation with no tab to close, and never asks', async () => {
    const c = calls();
    await requestCloseSession(session({ origin: 'terminal', status: 'running' }), requestDeps(c));

    expect(c.forgotten).toEqual(['s1']);
    expect(c.routed).toEqual([]);
    expect(c.confirmed).toEqual([]);
  });

  it('routes an idle editor conversation straight away, without asking', async () => {
    const c = calls();
    await requestCloseSession(session(), requestDeps(c));

    expect(c.routed).toEqual(['s1']);
    expect(c.confirmed).toEqual([]);
    expect(c.forgotten).toEqual([]);
  });

  it('asks first when the conversation is still working, then routes', async () => {
    const c = calls();
    await requestCloseSession(session({ status: 'running' }), requestDeps(c));

    expect(c.log).toEqual(['confirm', 'route']);
  });

  it('does nothing at all when the confirmation is declined — no close, no forget', async () => {
    const c = calls();
    await requestCloseSession(session({ status: 'waiting' }), requestDeps(c, false));

    expect(c.confirmed).toEqual(['s1']);
    expect(c.routed).toEqual([]);
    expect(c.forgotten).toEqual([]);
  });
});

describe('closeSessionHere', () => {
  it('archives the conversation before removing its row when a tab was really closed', async () => {
    const c = calls();
    await closeSessionHere('s1', hereDeps(c));

    expect(c.log).toEqual(['closeTab', 'archive', 'forget']);
    expect(c.archived).toEqual(['s1']);
  });

  it('removes the row WITHOUT archiving when no tab was found — nothing was closed', async () => {
    const c = calls();
    await closeSessionHere('s1', hereDeps(c, { closeTab: async () => 'notFound' }));

    expect(c.archived).toEqual([]);
    expect(c.forgotten).toEqual(['s1']);
  });

  it('only forgets when the session state has already vanished, and touches no tab', async () => {
    const c = calls();
    await closeSessionHere('s1', hereDeps(c, { read: async () => undefined }));

    expect(c.log).toEqual(['forget']);
  });
});
