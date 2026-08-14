import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, createGroup } from '../src/groups/model';
import { readGroups, updateGroups } from '../src/groups/store';
import {
  applyDrop,
  createGroupCommand,
  deleteGroupCommand,
  renameGroupCommand,
  runGroupAction,
} from '../src/groups/commands';

// Compte les écritures RÉELLES sur disque (writeFile, appelé par updateGroups avant chaque
// rename) : seul moyen de prouver qu'un dépôt de plusieurs sessions tient dans UNE SEULE
// écriture, jamais une par session — même convention que test/groups-purge.test.ts.
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

// Câblage réel de Task 9 : ces fonctions sont le seul chemin entre l'arbre
// (SessionsTree.onDrop) ou les trois commandes de dossier (package.json) et
// le fichier de classement. Chacune est ici exercée directement, sans vscode,
// sur un fichier jetable — même convention que test/groups-store.test.ts et
// test/groups-purge.test.ts : jamais le ~/.koh-claude réel.
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'koh-groups-commands-'));
  file = join(dir, 'groups.json');
  writeFileCalls.count = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createGroupCommand', () => {
  it('crée le dossier quand un nom est fourni', async () => {
    const out = await createGroupCommand(file, 'Perso', () => 'g1');

    expect(out?.groups).toEqual([{ id: 'g1', name: 'Perso', order: 0 }]);
    expect((await readGroups(file)).groups).toEqual([{ id: 'g1', name: 'Perso', order: 0 }]);
  });

  it("n'écrit rien quand le nom est undefined (boîte de saisie annulée)", async () => {
    const out = await createGroupCommand(file, undefined, () => 'g1');

    expect(out).toBeUndefined();
    expect((await readGroups(file)).groups).toEqual([]);
  });

  // Le point le plus important de la tâche : le modèle lève sur un nom vide
  // (createGroup, groups/model.ts), et cette levée doit rester observable ici
  // — c'est runGroupAction, plus bas, qui la transforme en message plutôt
  // qu'en trace d'appel non gérée, jamais cette fonction-ci.
  it('lève quand le nom est vide plutôt que de créer un dossier sans nom', async () => {
    await expect(createGroupCommand(file, '', () => 'g1')).rejects.toThrow(
      'Un dossier ne peut pas avoir un nom vide.',
    );
    expect((await readGroups(file)).groups).toEqual([]);
  });

  it('lève aussi quand le nom ne contient que des blancs', async () => {
    await expect(createGroupCommand(file, '   ', () => 'g1')).rejects.toThrow(
      'Un dossier ne peut pas avoir un nom vide.',
    );
  });
});

describe('renameGroupCommand', () => {
  it('renomme le dossier quand un nom est fourni', async () => {
    await updateGroups(file, (s) => createGroup(s, 'ancien', () => 'g1'));

    const out = await renameGroupCommand(file, 'g1', 'nouveau');

    expect(out?.groups).toEqual([{ id: 'g1', name: 'nouveau', order: 0 }]);
  });

  it("n'écrit rien quand le nom est undefined (boîte de saisie annulée)", async () => {
    await updateGroups(file, (s) => createGroup(s, 'ancien', () => 'g1'));

    const out = await renameGroupCommand(file, 'g1', undefined);

    expect(out).toBeUndefined();
    expect((await readGroups(file)).groups).toEqual([{ id: 'g1', name: 'ancien', order: 0 }]);
  });

  it('lève quand le nom est vide plutôt que de renommer vers un nom vide', async () => {
    await updateGroups(file, (s) => createGroup(s, 'ancien', () => 'g1'));

    await expect(renameGroupCommand(file, 'g1', '')).rejects.toThrow('Un dossier ne peut pas avoir un nom vide.');
    expect((await readGroups(file)).groups).toEqual([{ id: 'g1', name: 'ancien', order: 0 }]);
  });
});

describe('deleteGroupCommand', () => {
  it('supprime le dossier et libère les sessions qui y étaient classées', async () => {
    await updateGroups(file, (s) => assign(createGroup(s, 'à supprimer', () => 'g1'), 's1', 'g1'));

    const out = await deleteGroupCommand(file, 'g1');

    expect(out.groups).toEqual([]);
    expect(out.assignments).toEqual({});
  });
});

describe('applyDrop', () => {
  it('affecte toutes les sessions déposées au dossier ciblé, en une seule écriture', async () => {
    await updateGroups(file, (s) => createGroup(s, 'Taf', () => 'g1'));
    writeFileCalls.count = 0;

    const out = await applyDrop(file, ['s1', 's2', 's3'], 'g1');

    expect(out.assignments).toEqual({ s1: 'g1', s2: 'g1', s3: 'g1' });
    expect(writeFileCalls.count).toBe(1);
  });

  it('retire l affectation des sessions déposées sur « Sans dossier » (groupId undefined)', async () => {
    await updateGroups(file, (s) => assign(createGroup(s, 'Taf', () => 'g1'), 's1', 'g1'));

    const out = await applyDrop(file, ['s1'], undefined);

    expect(out.assignments).toEqual({});
  });

  it('ignore silencieusement un dossier inexistant, comme assign() (model.ts)', async () => {
    const out = await applyDrop(file, ['s1'], 'inconnu');

    expect(out.assignments).toEqual({});
  });
});

describe('runGroupAction', () => {
  it("n'appelle jamais onError quand l'action réussit", async () => {
    const onError = vi.fn();

    await runGroupAction(() => Promise.resolve('ok'), onError);

    expect(onError).not.toHaveBeenCalled();
  });

  // Le cas central de la tâche : une action qui lève (nom vide, entre autres)
  // ne doit jamais devenir une trace d'appel non gérée. runGroupAction est le
  // seul filet — sans lui, le rejet remonterait tel quel jusqu'au gestionnaire
  // de commande VSCode.
  it('capture ce que l action lève et le relaie comme message, sans laisser filer le rejet', async () => {
    const onError = vi.fn();

    await runGroupAction(() => Promise.reject(new Error('Un dossier ne peut pas avoir un nom vide.')), onError);

    expect(onError).toHaveBeenCalledWith('Un dossier ne peut pas avoir un nom vide.');
  });

  it('relaie aussi un rejet qui ne porte pas une vraie Error', async () => {
    const onError = vi.fn();

    await runGroupAction(() => Promise.reject('boom'), onError);

    expect(onError).toHaveBeenCalledWith('boom');
  });
});
