import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closedFile } from '../src/paths';
import { readClosed, rememberClosed } from '../src/closed/store';
import type { ClosedEntry } from '../src/closed/model';

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
});
