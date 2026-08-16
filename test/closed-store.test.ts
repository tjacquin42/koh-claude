import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closedFile } from '../src/paths';
import { readClosed, rememberClosed } from '../src/closed/store';
import { parseClosed, remember, serializeClosed, type ClosedEntry } from '../src/closed/model';

// `node:fs/promises` is a native module, mocked entirely by delegating to the real
// implementation except when a test arms the override — same convention as
// test/groups-store.test.ts. Used to inject a CONTROLLED interleaving point (never a
// timed race): an external write triggered from inside one specific `readFile` call,
// simulating another window writing at that exact instant.
const { readFileOverride } = vi.hoisted(() => ({
  readFileOverride: { current: undefined as ((path: string) => Promise<string> | undefined) | undefined },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (
      path: Parameters<typeof actual.readFile>[0],
      encoding?: Parameters<typeof actual.readFile>[1],
    ) => {
      const override = readFileOverride.current?.(String(path));
      return override !== undefined ? override : actual.readFile(path, encoding);
    },
  };
});

const entry = (id: string, closedAt: number): ClosedEntry => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode',
  closedAt,
});

let home: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'koh-closed-'));
  file = closedFile(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  readFileOverride.current = undefined;
});

describe('readClosed', () => {
  it('reads an absent file as an empty list', async () => {
    expect((await readClosed(file)).closed).toEqual([]);
  });

  it('reads an unreadable file as an empty list rather than throwing', async () => {
    await writeFile(file, 'pas du json', 'utf8');
    expect((await readClosed(file)).closed).toEqual([]);
  });
});

describe('rememberClosed', () => {
  it('writes an entry that reads back', async () => {
    await rememberClosed(file, entry('a', 1));
    expect((await readClosed(file)).closed.map((e) => e.id)).toEqual(['a']);
  });

  it('keeps what another window wrote before us', async () => {
    await writeFile(file, JSON.stringify({ closed: [entry('other', 5)] }), 'utf8');
    await rememberClosed(file, entry('ours', 6));
    expect((await readClosed(file)).closed.map((e) => e.id)).toEqual(['ours', 'other']);
  });

  it('loses neither entry when two closes race in the same window', async () => {
    await Promise.all([rememberClosed(file, entry('a', 1)), rememberClosed(file, entry('b', 2))]);
    expect((await readClosed(file)).closed.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves no temporary file behind', async () => {
    await rememberClosed(file, entry('a', 1));
    expect((await readdir(home)).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  // This is the test the `Promise.all` race above cannot be: the in-process queue
  // fully serialises same-file calls, so two `rememberClosed` calls launched together
  // never actually interleave their reads — the queue alone accounts for that test
  // passing. This test forces the interleaving the queue cannot prevent (a SEPARATE
  // process writing at the exact instant between our merge and our rename), by
  // injecting a real external write from inside the one `readFile` call that is
  // `writeIfUnchanged`'s check-read on the first attempt. If the CAS-and-retry logic
  // were missing or broken, this write would be silently clobbered by our `rename`.
  it('absorbs an external write that lands between the merge and the rename', async () => {
    await rememberClosed(file, entry('base', 1));

    let calls = 0;
    readFileOverride.current = (path) => {
      // The 2nd read of `closed.json` in this call is `writeIfUnchanged`'s check-read
      // on the first attempt: 1st read is `rememberOnce`'s pre-loop `readRaw`.
      if (!path.endsWith('closed.json') || (calls += 1) !== 2) return undefined;
      return (async () => {
        const current = await readFile(path, 'utf8');
        await writeFile(path, serializeClosed(remember(parseClosed(current), entry('other', 2))), 'utf8');
        return readFile(path, 'utf8');
      })();
    };

    const out = await rememberClosed(file, entry('mine', 3));

    expect(out.closed.map((e) => e.id).sort()).toEqual(['base', 'mine', 'other']);
    expect((await readClosed(file)).closed.map((e) => e.id).sort()).toEqual(['base', 'mine', 'other']);
  });
});
