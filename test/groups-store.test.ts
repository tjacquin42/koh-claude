import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, createGroup, deleteGroup, emptyGroups, parseGroups, serializeGroups, sessionOrderOf, setGroupColor, setSessionOrder } from '../src/groups/model';
import { readGroups, updateGroups } from '../src/groups/store';

// `node:fs/promises` est un module natif, mocké entièrement en délégant à l'implémentation
// réelle sauf quand un test arme l'un des overrides — même convention que test/watcher.test.ts.
// Sert à injecter un point d'entrelacement PILOTÉ (jamais chronométré) : une écriture d'une
// autre fenêtre déclenchée depuis l'intérieur d'un appel précis à `readFile`, ou un échec
// déclenché depuis un appel précis à `rename`, plutôt qu'une course espérée avec des délais.
const { readFileOverride, renameOverride } = vi.hoisted(() => ({
  readFileOverride: { current: undefined as ((path: string) => Promise<string> | undefined) | undefined },
  renameOverride: {
    current: undefined as ((oldPath: string, newPath: string) => Promise<void> | undefined) | undefined,
  },
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
    rename: (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      const override = renameOverride.current?.(String(oldPath), String(newPath));
      return override !== undefined ? override : actual.rename(oldPath, newPath);
    },
  };
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'koh-groups-'));
  file = join(dir, 'groups.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  readFileOverride.current = undefined;
  renameOverride.current = undefined;
});

describe('groups store', () => {
  it('un fichier absent vaut un classement vide', async () => {
    expect(await readGroups(join(dir, 'rien.json'))).toEqual(emptyGroups());
  });

  it('un fichier illisible vaut un classement vide, sans lever', async () => {
    await writeFile(file, 'pas du json');
    expect(await readGroups(file)).toEqual(emptyGroups());
  });

  it('relit juste avant d écrire : la modification d une autre fenêtre survit', async () => {
    await updateGroups(file, (s) => createGroup(s, 'mien', () => 'g1'));
    // point d'entrelacement injecté : une autre fenêtre écrit pendant notre transformation
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(createGroup(parseGroups(await readFile(file, 'utf8')), 'sien', () => 'g2')),
      );
      return assign(s, 's1', 'g1');
    });
    expect(out.groups.map((g) => g.name)).toEqual(['mien', 'sien']);
  });

  it('une couleur posée ici survit à l écriture simultanée d une autre fenêtre', async () => {
    // Le défaut d origine : la fusion ne propageait que le nom, et perdait en
    // silence tout autre attribut du dossier.
    await updateGroups(file, (s) => createGroup(s, 'mien', () => 'g1'));
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(createGroup(parseGroups(await readFile(file, 'utf8')), 'sien', () => 'g2')),
      );
      return setGroupColor(s, 'g1', 'purple');
    });
    expect(out.groups.map((g) => [g.name, g.color])).toEqual([
      ['mien', 'purple'],
      ['sien', undefined],
    ]);
    expect((await readGroups(file)).groups[0]?.color).toBe('purple');
  });

  it('une couleur retirée ici n est pas ressuscitée par l état plus frais', async () => {
    await updateGroups(file, (s) => setGroupColor(createGroup(s, 'mien', () => 'g1'), 'g1', 'red'));
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(createGroup(parseGroups(await readFile(file, 'utf8')), 'sien', () => 'g2')),
      );
      return setGroupColor(s, 'g1', undefined);
    });
    expect(out.groups[0]).not.toHaveProperty('color');
  });

  it('ranger dans un dossier n efface pas l ordre qu une autre fenêtre pose dans un autre', async () => {
    // Le défaut que ce test garde : prendre `after.sessionOrder` en bloc
    // écrasait tous les dossiers, pas seulement celui qu on venait de ranger.
    await updateGroups(file, (s) => createGroup(createGroup(s, 'mien', () => 'g1'), 'sien', () => 'g2'));
    const out = await updateGroups(file, async (s) => {
      const fresh = parseGroups(await readFile(file, 'utf8'));
      await writeFile(file, serializeGroups(setSessionOrder(fresh, 'g2', ['x', 'y'])));
      return setSessionOrder(s, 'g1', ['a', 'b']);
    });
    expect(sessionOrderOf(out, 'g1')).toEqual(['a', 'b']);
    expect(sessionOrderOf(out, 'g2')).toEqual(['x', 'y']);
    const reread = await readGroups(file);
    expect(sessionOrderOf(reread, 'g2')).toEqual(['x', 'y']);
  });

  it('un ordre réordonné ici gagne sur celui, plus ancien, du fichier', async () => {
    await updateGroups(file, (s) => setSessionOrder(createGroup(s, 'mien', () => 'g1'), 'g1', ['a', 'b', 'c']));
    const out = await updateGroups(file, async (s) => {
      const fresh = parseGroups(await readFile(file, 'utf8'));
      await writeFile(file, serializeGroups(createGroup(fresh, 'ailleurs', () => 'g2')));
      return setSessionOrder(s, 'g1', ['c', 'a', 'b']);
    });
    expect(sessionOrderOf(out, 'g1')).toEqual(['c', 'a', 'b']);
    expect(out.groups.map((g) => g.name)).toEqual(['mien', 'ailleurs']);
  });

  it('un dossier supprimé ici reste supprimé même si l autre fenêtre l ignorait', async () => {
    await updateGroups(file, (s) => createGroup(s, 'à supprimer', () => 'g1'));
    // point d'entrelacement injecté : une autre fenêtre, qui ignore la suppression en cours,
    // écrit un dossier sans rapport pendant notre transformation
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(createGroup(parseGroups(await readFile(file, 'utf8')), 'ailleurs', () => 'g2')),
      );
      return deleteGroup(s, 'g1');
    });
    expect(out.groups.map((g) => g.name)).toEqual(['ailleurs']);
  });

  it('une affectation faite ailleurs ne disparaît pas parce qu on ne la connaissait pas', async () => {
    await updateGroups(file, (s) => createGroup(s, 'dossier', () => 'g1'));
    // point d'entrelacement injecté : une autre fenêtre affecte une session pendant notre
    // transformation, qui elle ne touche qu'à un dossier sans rapport avec cette affectation
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(assign(parseGroups(await readFile(file, 'utf8')), 'session-ailleurs', 'g1')),
      );
      return createGroup(s, 'autre', () => 'g2');
    });
    expect(out.assignments).toEqual({ 'session-ailleurs': 'g1' });
    expect(out.groups.map((g) => g.name).sort()).toEqual(['autre', 'dossier']);
  });

  // Tour de correction 2, Mineur : une suppression concurrente à une affectation vers le même
  // dossier produit une affectation orpheline transitoire dans le résultat immédiat de
  // `updateGroups` (la fusion ne connaît pas les invariants de `parseGroups`, elle ne fait que
  // combiner). Elle ne persiste pas : `parseGroups`, appelé par toute lecture suivante, filtre
  // déjà toute affectation qui ne pointe sur aucun dossier existant (voir groups-model.test.ts).
  it('une affectation orpheline transitoire se corrige à la lecture suivante', async () => {
    await updateGroups(file, (s) => createGroup(s, 'à supprimer', () => 'g1'));
    // point d'entrelacement injecté : une autre fenêtre affecte une session à g1 pendant qu on
    // le supprime, sans savoir que la suppression est en cours
    const out = await updateGroups(file, async (s) => {
      await writeFile(
        file,
        serializeGroups(assign(parseGroups(await readFile(file, 'utf8')), 's-orpheline', 'g1')),
      );
      return deleteGroup(s, 'g1');
    });

    // état transitoire immédiat : la fusion écrit l'affectation orpheline telle quelle
    expect(out.groups).toEqual([]);
    expect(out.assignments).toEqual({ 's-orpheline': 'g1' });

    // la lecture suivante s'auto-corrige
    expect((await readGroups(file)).assignments).toEqual({});
  });

  it('écrit de façon atomique : aucun fichier temporaire ne subsiste', async () => {
    await updateGroups(file, (s) => createGroup(s, 'x', () => 'g1'));
    const restes = (await readdir(dir)).filter((n) => n.startsWith('.tmp'));
    expect(restes).toEqual([]);
  });

  // Tour de correction 2, Important : ce comportement était déjà correct (vérifié à l'exécution
  // par le relecteur) mais non couvert — exactement le genre de garantie qui casse en silence,
  // comme le gel vécu au lot précédent sur une garde de réentrance dont le drapeau restait levé.
  it('un rename qui échoue ne laisse aucun fichier temporaire', async () => {
    renameOverride.current = () => Promise.reject(new Error('disque plein'));

    await expect(updateGroups(file, (s) => createGroup(s, 'x', () => 'g1'))).rejects.toThrow('disque plein');

    renameOverride.current = undefined;
    const restes = (await readdir(dir)).filter((n) => n.startsWith('.tmp'));
    expect(restes).toEqual([]);
  });

  // Tour de correction 2, Important : idem — une transformation qui lève ne doit pas laisser la
  // file bloquée pour toujours (c'est précisément le gel vécu au lot précédent).
  it('une transformation qui lève ne bloque pas la file pour les appels suivants', async () => {
    await expect(
      updateGroups(file, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const out = await updateGroups(file, (s) => createGroup(s, 'après', () => 'g1'));
    expect(out.groups.map((g) => g.name)).toEqual(['après']);
  });

  it('préserve les champs inconnus au travers d un aller-retour', async () => {
    await writeFile(file, JSON.stringify({ version: 1, groups: [], assignments: {}, futur: 42 }));
    await updateGroups(file, (s) => createGroup(s, 'x', () => 'g1'));
    const written = JSON.parse(await readFile(file, 'utf8')) as { futur: number };
    expect(written.futur).toBe(42);
  });

  // Tour de correction 1 (mécanisme 2) : une écriture externe qui survient exactement entre
  // notre fusion (le contenu qu'on vient de lire comme `latest`) et notre `rename` doit être
  // absorbée par une nouvelle tentative plutôt qu'écrasée. Point d'entrelacement piloté : le
  // 3ᵉ appel à `readFile` sur ce fichier — c'est la relecture de contrôle faite juste avant de
  // renommer, à la fin de la première tentative — déclenche une écriture réelle avant de
  // rendre la main, simulant une autre fenêtre qui écrit à cet instant précis.
  it('une écriture externe entre la fusion et le renommage est absorbée par une nouvelle tentative', async () => {
    await updateGroups(file, (s) => createGroup(s, 'base', () => 'g-base'));

    let calls = 0;
    readFileOverride.current = (path) => {
      if (!path.endsWith('groups.json') || (calls += 1) !== 3) return undefined;
      return (async () => {
        const current = await readFile(path, 'utf8');
        await writeFile(
          path,
          serializeGroups(createGroup(parseGroups(current), 'ailleurs', () => 'g-else')),
          'utf8',
        );
        return readFile(path, 'utf8');
      })();
    };

    const out = await updateGroups(file, (s) => createGroup(s, 'mine', () => 'g-mine'));

    expect(out.groups.map((g) => g.name).sort()).toEqual(['ailleurs', 'base', 'mine']);
  });

  // Tour de correction 2, Critique : la dernière tentative doit relire elle aussi avant de
  // renommer, exactement comme les précédentes — c'est la tentative qu'on n'atteint qu'en cas
  // de contention réelle et soutenue, donc précisément celle où une autre fenêtre a le plus de
  // chances d'être en train d'écrire. Trois écritures externes injectées, une à chaque relecture
  // de contrôle (les trois seules tentatives budgétées) : si la dernière relecture était encore
  // sautée, le troisième ajout serait écrasé en silence par le `rename` final. Les override de
  // `readFile` ci-dessous utilisent `node:fs` synchrone (non mocké) pour l'écriture externe,
  // afin de ne pas ré-entrer dans le `readFile` mocké et fausser le compteur d'appels.
  it('la dernière tentative relit aussi avant de renommer, sous contention soutenue', async () => {
    await updateGroups(file, (s) => createGroup(s, 'base', () => 'g-base'));

    let calls = 0;
    readFileOverride.current = (path) => {
      calls += 1;
      if (!path.endsWith('groups.json') || calls < 3 || calls > 5) return undefined;
      const label = `ext${calls - 2}`;
      const current = readFileSync(path, 'utf8');
      writeFileSync(path, serializeGroups(createGroup(parseGroups(current), label, () => `g-${label}`)), 'utf8');
      return Promise.resolve(readFileSync(path, 'utf8'));
    };

    const out = await updateGroups(file, (s) => createGroup(s, 'mine', () => 'g-mine'));

    expect(out.groups.map((g) => g.name).sort()).toEqual(['base', 'ext1', 'ext2', 'ext3', 'mine']);
  });

  // Tour de correction 1 (mécanisme 1) : réactivé. Ce test (verbatim du brief) échouait de
  // façon reproductible contre la première implémentation — mesuré à 0/30 (voir task-5-report.md).
  // Ce n'était pas un défaut de mergeGroups/mergeAssignments (les tests ci-dessus prouvent
  // qu'ils fusionnent correctement dès qu'on leur donne un instantané `latest` cohérent), mais
  // l'absence de toute garantie que deux appels à `updateGroups` sur le même fichier, lancés
  // depuis le même processus, ne s'exécutent jamais en même temps. `updateGroups` sérialise
  // maintenant ces appels par fichier (`enqueue`) : exactement le cas que `Promise.all` exerce
  // ici.
  it('deux mises à jour concurrentes ne se perdent pas', async () => {
    await Promise.all([
      updateGroups(file, (s) => createGroup(s, 'a', () => 'ga')),
      updateGroups(file, (s) => createGroup(s, 'b', () => 'gb')),
    ]);
    expect((await readGroups(file)).groups).toHaveLength(2);
  });
});
