import { describe, expect, it } from 'vitest';
import {
  emptyClosed,
  isReopenable,
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

  it('carries a title already known for that id forward when a re-archive lacks one', () => {
    // A window that never rendered this conversation has no transcript entry
    // for it, so its own archive call has no title to offer — but the entry
    // already in the file does, and that must not be lost.
    const withTitle = remember(emptyClosed(), entry('a', 1, { title: 'Ajouter la corbeille' }));
    const reArchived = remember(withTitle, entry('a', 5));
    expect(reArchived.closed[0]).toMatchObject({ id: 'a', title: 'Ajouter la corbeille', closedAt: 5 });
  });

  it('carries a branch already known for that id forward the same way', () => {
    const withBranch = remember(emptyClosed(), entry('a', 1, { branch: 'feat-x' }));
    const reArchived = remember(withBranch, entry('a', 5));
    expect(reArchived.closed[0]).toMatchObject({ id: 'a', branch: 'feat-x', closedAt: 5 });
  });

  it('lets an incoming title win over an older one, rather than always keeping the first', () => {
    const first = remember(emptyClosed(), entry('a', 1, { title: 'Old' }));
    const second = remember(first, entry('a', 5, { title: 'New' }));
    expect(second.closed[0]?.title).toBe('New');
  });

  it('never carries a title from one id over to another', () => {
    const withTitle = remember(emptyClosed(), entry('a', 1, { title: 'Titre de a' }));
    const other = remember(withTitle, entry('b', 2));
    expect(other.closed.find((e) => e.id === 'b')?.title).toBeUndefined();
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

  it('trims text fields, like name() does in the groups model', () => {
    const raw = JSON.stringify({
      closed: [
        { id: 'a', cwd: '  /Users/dev/projet  ', project: '  projet  ', branch: '  feat-x  ', title: '  Titre  ', origin: 'vscode', closedAt: 1 },
      ],
    });
    expect(parseClosed(raw).closed[0]).toMatchObject({
      cwd: '/Users/dev/projet',
      project: 'projet',
      branch: 'feat-x',
      title: 'Titre',
    });
  });
});

describe('isReopenable', () => {
  it('matches exactly the origins reopenPlan turns into something other than an explanation', () => {
    expect(isReopenable('vscode')).toBe(true);
    expect(isReopenable('desktop')).toBe(true);
    expect(isReopenable('terminal')).toBe(true);
    expect(isReopenable('sdk')).toBe(false);
    expect(isReopenable('unknown')).toBe(false);
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
