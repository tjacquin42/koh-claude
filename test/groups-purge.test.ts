import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, writeSession } from '../src/spool/persist';
import { assign, createGroup, parseGroups, serializeGroups } from '../src/groups/model';
import { readGroups, updateGroups } from '../src/groups/store';
import { pruneAssignmentsAfterPurge } from '../src/groups/purge';

// Compte les écritures RÉELLES sur disque (writeFile, appelé par updateGroups avant chaque
// rename) : le seul moyen de démontrer qu'aucune écriture n'a eu lieu, pas seulement que le
// résultat lu ensuite est correct — un test qui ne vérifierait que le contenu final ne
// distinguerait pas « rien écrit » de « réécrit à l'identique ». `readFileOverride` sert au
// point d'entrelacement piloté du dernier test : jamais chronométré, déclenché depuis un appel
// précis à `readFile` sur `groups.json` — même convention que test/groups-store.test.ts.
const { writeFileCalls, readFileOverride } = vi.hoisted(() => ({
  writeFileCalls: { count: 0 },
  readFileOverride: { current: undefined as ((path: string) => Promise<string> | undefined) | undefined },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      writeFileCalls.count += 1;
      return actual.writeFile(...args);
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
  readFileOverride.current = undefined;
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

  // Tour de correction 1, Critique 2 : isole le premier garde-fou (purged vide). Une
  // affectation déjà morte ('fantome', jamais vivante) existe dès le départ : si seul le
  // premier garde-fou disparaissait, le second laisserait quand même passer, puisqu'il
  // trouverait bien quelque chose à retirer, et ce test tomberait. Sans cette affectation
  // morte, ce test ne prouve rien sur le premier garde-fou : le second suffirait déjà à
  // bloquer l'écriture, et les deux resteraient indiscernables l'un de l'autre.
  it('n écrit rien quand rien n a été purgé, même s il existe déjà une affectation morte', async () => {
    await writeSession(dirs, session('vivante'));
    await updateGroups(file, (s) => {
      const withGroup = createGroup(s, 'dossier', () => 'g1');
      return assign(assign(withGroup, 'vivante', 'g1'), 'fantome', 'g1');
    });
    writeFileCalls.count = 0;

    await pruneAssignmentsAfterPurge(dirs, file, []);

    expect(writeFileCalls.count).toBe(0);
    expect((await readGroups(file)).assignments).toEqual({ vivante: 'g1', fantome: 'g1' });
  });

  it('n écrit rien quand la session purgée n était classée dans aucun dossier', async () => {
    await writeSession(dirs, session('vivante'));
    await updateGroups(file, (s) => assign(createGroup(s, 'dossier', () => 'g1'), 'vivante', 'g1'));
    writeFileCalls.count = 0;

    await pruneAssignmentsAfterPurge(dirs, file, ['jamais-classee']);

    expect(writeFileCalls.count).toBe(0);
    expect((await readGroups(file)).assignments).toEqual({ vivante: 'g1' });
  });

  // Tour de correction 1, Critique 1 : une session peut apparaître et être classée PENDANT que
  // ce nettoyage est en vol. Point d'entrelacement piloté sur la 2ᵉ lecture de `groups.json` —
  // c'est très précisément la lecture de `before` à l'intérieur d'`updateGroups`, juste après
  // le garde-fou 2 (1ʳᵉ lecture). À cet instant, une autre fenêtre fait vivre 's2' (fichier de
  // session écrit directement dans sessions/, comme le ferait un hook) et le classe dans 'g1'
  // (écriture externe de groups.json, simulant un glisser-déposer) — exactement le scénario
  // décrit par le relecteur : `live`, s'il était figé plus tôt, ignorerait 's2' alors que
  // l'état relu par `updateGroups` contient déjà son affectation.
  it('une session classée pendant que le nettoyage est en vol garde son classement', async () => {
    await updateGroups(file, (s) => assign(createGroup(s, 'dossier', () => 'g1'), 's1', 'g1'));

    let groupsFileReads = 0;
    readFileOverride.current = (path) => {
      if (!path.endsWith('groups.json')) return undefined;
      groupsFileReads += 1;
      if (groupsFileReads !== 2) return undefined;
      return (async () => {
        writeFileSync(join(dirs.sessions, 's2.json'), JSON.stringify(session('s2')), 'utf8');
        const current = readFileSync(path, 'utf8');
        writeFileSync(path, serializeGroups(assign(parseGroups(current), 's2', 'g1')), 'utf8');
        return readFileSync(path, 'utf8');
      })();
    };

    // 's1' n'a jamais eu de fichier de session dans sessions/ : c'est précisément la session
    // déjà purgée qui déclenche ce nettoyage.
    await pruneAssignmentsAfterPurge(dirs, file, ['s1']);

    expect((await readGroups(file)).assignments).toEqual({ s2: 'g1' });
  });
});
