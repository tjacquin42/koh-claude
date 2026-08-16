import { describe, expect, it } from 'vitest';
import {
  emptyClosed,
  MAX_CLOSED,
  parseClosed,
  remember,
  serializeClosed,
  toClosedEntry,
  type ClosedEntry,
} from '../src/closed/model';

const entry = (id: string, closedAt: number, over: Partial<ClosedEntry> = {}): ClosedEntry => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  closedAt,
  ...over,
});

describe('remember', () => {
  it('puts the newest entry first', () => {
    const s = remember(remember(emptyClosed(), entry('a', 1)), entry('b', 2));
    expect(s.closed.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('keeps at most MAX_CLOSED entries, dropping the oldest', () => {
    let s = emptyClosed();
    for (let i = 0; i < MAX_CLOSED + 3; i++) s = remember(s, entry(`s${i}`, i));
    expect(s.closed).toHaveLength(MAX_CLOSED);
    expect(s.closed.map((e) => e.id)).toEqual(['s7', 's6', 's5', 's4', 's3']);
  });

  it('never lists the same conversation twice, keeping the most recent close', () => {
    const s = remember(remember(emptyClosed(), entry('a', 1, { title: 'old' })), entry('a', 9, { title: 'new' }));
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]?.title).toBe('new');
  });

  it('is idempotent: replaying the same close changes nothing', () => {
    const once = remember(emptyClosed(), entry('a', 5));
    const twice = remember(once, entry('a', 5));
    expect(twice.closed).toEqual(once.closed);
  });
});

describe('parseClosed', () => {
  it('reads back what serializeClosed wrote', () => {
    const s = remember(emptyClosed(), entry('a', 5, { branch: 'feat-x', title: 'Titre' }));
    expect(parseClosed(serializeClosed(s)).closed).toEqual(s.closed);
  });

  it('treats unreadable content as an empty list', () => {
    expect(parseClosed('pas du json').closed).toEqual([]);
    expect(parseClosed('[]').closed).toEqual([]);
    expect(parseClosed('{"closed":"nope"}').closed).toEqual([]);
  });

  it('drops entries that are missing a required field or carry a bad one', () => {
    const raw = JSON.stringify({
      closed: [
        { id: 'ok', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode', closedAt: 1 },
        { cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode', closedAt: 2 },
        { id: 'bad-origin', cwd: '/Users/dev/projet', project: 'projet', origin: 'martian', closedAt: 3 },
        { id: 'bad-date', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode', closedAt: 'hier' },
        { id: '../escape', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode', closedAt: 4 },
      ],
    });
    expect(parseClosed(raw).closed.map((e) => e.id)).toEqual(['ok']);
  });

  it('carries unknown top-level keys through a round trip', () => {
    const raw = JSON.stringify({ closed: [], somethingNewer: { a: 1 } });
    expect(JSON.parse(serializeClosed(parseClosed(raw)))).toMatchObject({ somethingNewer: { a: 1 } });
  });
});

describe('toClosedEntry', () => {
  it('keeps what a row displays and stamps the close time', () => {
    expect(toClosedEntry({ id: 'a', cwd: '/Users/dev/projet', project: 'projet', origin: 'terminal' }, 42)).toEqual({
      id: 'a',
      cwd: '/Users/dev/projet',
      project: 'projet',
      origin: 'terminal',
      closedAt: 42,
    });
  });

  it('omits an absent branch and title instead of writing undefined keys', () => {
    const entry = toClosedEntry({ id: 'a', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode' }, 1);
    expect(Object.keys(entry).sort()).toEqual(['closedAt', 'cwd', 'id', 'origin', 'project']);
  });
});
