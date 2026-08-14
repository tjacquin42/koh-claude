import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, writeSession } from '../src/spool/persist';
import { assign, createGroup } from '../src/groups/model';
import { readGroups, updateGroups } from '../src/groups/store';
import { pruneAssignmentsAfterPurge } from '../src/groups/purge';

// Compte les écritures RÉELLES sur disque (writeFile, appelé par updateGroups avant chaque
// rename) : le seul moyen de démontrer qu'aucune écriture n'a eu lieu, pas seulement que le
// résultat lu ensuite est correct — un test qui ne vérifierait que le contenu final ne
// distinguerait pas « rien écrit » de « réécrit à l'identique ».
const { writeFileCalls } = vi.hoisted(() => ({ writeFileCalls: { count: 0 } }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      writeFileCalls.count += 1;
      return actual.writeFile(...args);
    },
  };
});

let home: string;
let dirs: SpoolDirs;
let file: string;

const session = (id: string) => ({
  id,
  cwd: '/Users/dev/projet',
  project: 'projet',
  origin: 'vscode' as const,
  status: 'idle' as const,
  toolCount: 0,
  lastEventAt: 1,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-groups-purge-'));
  dirs = spoolDirs(home);
  file = join(home, 'groups.json');
  await ensureDirs(dirs);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('pruneAssignmentsAfterPurge', () => {
  it('retire l affectation de la session purgée, garde celle d une session encore vivante', async () => {
    await writeSession(dirs, session('vivante'));
    await updateGroups(file, (s) => {
      const withGroup = createGroup(s, 'dossier', () => 'g1');
      return assign(assign(withGroup, 'vivante', 'g1'), 'purgee', 'g1');
    });

    await pruneAssignmentsAfterPurge(dirs, file, ['purgee']);

    expect((await readGroups(file)).assignments).toEqual({ vivante: 'g1' });
  });

  it('n écrit rien quand rien n a été purgé', async () => {
    await writeSession(dirs, session('vivante'));
    await updateGroups(file, (s) => assign(createGroup(s, 'dossier', () => 'g1'), 'vivante', 'g1'));
    writeFileCalls.count = 0;

    await pruneAssignmentsAfterPurge(dirs, file, []);

    expect(writeFileCalls.count).toBe(0);
  });

  it('n écrit rien quand la session purgée n était classée dans aucun dossier', async () => {
    await writeSession(dirs, session('vivante'));
    await updateGroups(file, (s) => assign(createGroup(s, 'dossier', () => 'g1'), 'vivante', 'g1'));
    writeFileCalls.count = 0;

    await pruneAssignmentsAfterPurge(dirs, file, ['jamais-classee']);

    expect(writeFileCalls.count).toBe(0);
    expect((await readGroups(file)).assignments).toEqual({ vivante: 'g1' });
  });
});
