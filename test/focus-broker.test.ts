import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs } from '../src/spool/persist';
import { FocusBroker } from '../src/focus/broker';
import type { Session } from '../src/events/types';
import type { ClosedEntry } from '../src/closed/model';

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  cwd: '/Users/dev/projet',
  project: 'projet',
  branch: 'feat-x',
  origin: 'vscode',
  status: 'done_unseen',
  toolCount: 0,
  lastEventAt: 0,
  ...over,
});

let home: string;
let dirs: SpoolDirs;
// Un `request()` non revendiqué arme un minuteur de repli à 2s réelles :
// sans stop(), il survivrait au test et pourrait lancer `code -r` pour de
// vrai une fois le test terminé. Chaque broker créé par un test s'enregistre
// ici pour être arrêté sans exception dans afterEach.
let brokers: FocusBroker[];

function makeBroker(): FocusBroker {
  const b = new FocusBroker(dirs);
  brokers.push(b);
  return b;
}

/**
 * Pose les dossiers de l'espace de travail sur le bouchon de `vscode`.
 *
 * La vraie API les expose en LECTURE SEULE, et c'est bien contre elle que le
 * typeur travaille — un bouchon qui divergerait de ses signatures ne prouverait
 * plus rien. Cette vue étroite dit donc exactement ce qu'on force, et rien de
 * plus : le jour où l'API changerait de forme, la ligne casserait ici.
 */
function setWorkspaceFolders(folders: readonly { uri: { fsPath: string } }[] | undefined): void {
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = folders;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-broker-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
  setWorkspaceFolders(undefined);
  vi.restoreAllMocks();
  brokers = [];
});

afterEach(() => {
  for (const b of brokers) b.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('FocusBroker.request', () => {
  it('révèle le panneau de la session (par son identifiant) quand la fenêtre courante la revendique', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const broker = makeBroker();

    await broker.request(session({ id: 'sess-1' }));

    expect(executeCommand).toHaveBeenCalledWith('claude-vscode.editor.open', 'sess-1');
  });

  it("n'exécute aucune commande pour une session terminal revendiquée localement — elle explique à la place", async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const broker = makeBroker();

    await broker.request(session({ origin: 'terminal' }));

    expect(executeCommand).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalled();
  });

  it("écrit un fichier de requête portant le libellé et l'origine de la session quand aucune fenêtre ne la revendique", async () => {
    const broker = makeBroker();

    await broker.request(session({ id: 's-remote', branch: 'feat-x', origin: 'vscode' }));

    const raw = await readFile(join(dirs.requests, 'focus-s-remote.json'), 'utf8');
    const parsed = JSON.parse(raw) as { sessionId: string; cwd: string; label: string; origin: string };
    expect(parsed.sessionId).toBe('s-remote');
    expect(parsed.label).toBe('projet · feat-x'); // sessionLabel() retombe sur projet · branche sans titre
    expect(parsed.origin).toBe('vscode');
  });
});

describe('FocusBroker — consommation des requêtes (I3)', () => {
  it("focalise sans attendre que le message d'information se referme", async () => {
    // Un vrai showInformationMessage ne se règle qu'à la fermeture du toast :
    // simulé ici par une promesse qui ne se règle jamais. Si le broker
    // l'attendait encore avant de focaliser (bug I3), l'appel ci-dessous à
    // consume() ne se terminerait jamais et ce test expirerait sur le délai
    // par défaut de vitest — piloté par l'enchaînement réel des promesses,
    // jamais par un minuteur ajouté pour l'occasion.
    let messageCalled = false;
    let focusCalled = false;
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(() => {
      messageCalled = true;
      return new Promise<undefined>(() => undefined);
    });
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async () => {
      focusCalled = true;
      return undefined;
    });
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);

    // La requête est écrite pendant que personne ne revendie encore (dossier
    // vide), pour forcer l'écriture d'un fichier plutôt qu'un focus direct.
    setWorkspaceFolders(undefined);
    const other = makeBroker();
    await other.request(session({ id: 's-cross' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(messageCalled).toBe(true);
    expect(focusCalled).toBe(true);
  });

  it('nomme la session dans le message plutôt que rester générique (mineur T11)', async () => {
    let message: unknown;
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((m: string) => {
      message = m;
      return new Promise<undefined>(() => undefined);
    });
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 's-cross', branch: 'feat-x' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(typeof message).toBe('string');
    expect(message as string).toContain('feat-x');
  });

  it('ignore une requête que la fenêtre courante ne revendique pas', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 's-cross' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/autre-projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reçoit exactement la commande de révélation, avec l identifiant de session en argument', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 'sess-1', origin: 'vscode' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(executeCommand).toHaveBeenCalledWith('claude-vscode.editor.open', 'sess-1');
  });

  it("n'affiche qu'un seul message pour une session distante hors éditeur — l'annonce et l'explication ne doivent pas se contredire", async () => {
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 's-term', origin: 'terminal' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("n'exécute aucune commande pour une session terminal consommée à distance", async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 's-term', origin: 'terminal' }));

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("n'exécute aucune commande pour une requête sans champ origin (écrite par une version antérieure)", async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await writeFile(
      join(dirs.requests, 'focus-s-legacy.json'),
      JSON.stringify({ sessionId: 's-legacy', cwd: '/Users/dev/projet', label: 'projet · feat-x', at: Date.now() }),
      'utf8',
    );

    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe('requestReopen', () => {
  const entry = (over: Partial<ClosedEntry> = {}): ClosedEntry => ({
    id: 's1',
    cwd: '/Users/dev/projet',
    project: 'projet',
    origin: 'vscode',
    closedAt: 0,
    ...over,
  });

  it('reopens straight away when this window claims the folder', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await makeBroker().requestReopen(entry());
    expect(run).toHaveBeenCalledWith('claude-vscode.editor.open', 's1');
    expect(await readdir(dirs.requests)).toEqual([]);
  });

  it('writes a request when another window holds the folder', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/autre' } }]);
    await makeBroker().requestReopen(entry());
    expect(await readdir(dirs.requests)).toEqual(['reopen-s1.json']);
  });

  it('opens a terminal conversation without ever writing a request', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/autre' } }]);
    await makeBroker().requestReopen(entry({ origin: 'terminal' }));
    expect(await readdir(dirs.requests)).toEqual([]);
  });

  it('consumes a reopen request written for a folder it holds', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await writeFile(
      join(dirs.requests, 'reopen-s9.json'),
      JSON.stringify({ sessionId: 's9', cwd: '/Users/dev/projet', label: 'projet', origin: 'vscode', at: Date.now() }),
      'utf8',
    );
    const broker = makeBroker();
    broker.start();
    await vi.waitFor(async () => {
      expect(run).toHaveBeenCalledWith('claude-vscode.editor.open', 's9');
    });
    expect(await readdir(dirs.requests)).toEqual([]);
  });

  it('ignores a reopen request that carries a terminal origin', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const terminal = vi.spyOn(vscode.window, 'createTerminal');
    await writeFile(
      join(dirs.requests, 'reopen-s9.json'),
      JSON.stringify({ sessionId: 's9', cwd: '/Users/dev/projet', label: 'projet', origin: 'terminal', at: Date.now() }),
      'utf8',
    );
    const broker = makeBroker();
    broker.start();
    await vi.waitFor(async () => {
      expect(await readdir(dirs.requests)).toEqual([]);
    });
    expect(terminal).not.toHaveBeenCalled();
  });

  it('explains rather than staying silent for an origin reopenPlan cannot turn into a command, even when this window holds the folder', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await makeBroker().requestReopen(entry({ origin: 'sdk' }));
    expect(info).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(dirs.requests)).toEqual([]);
  });

  it('explains locally rather than writing a request when no window holds the folder either, since no window could reopen this origin', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/autre' } }]);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await makeBroker().requestReopen(entry({ origin: 'unknown' }));
    expect(info).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(dirs.requests)).toEqual([]);
  });

  it('warns instead of leaving a rejection unhandled when the editor command is missing on the local path', async () => {
    setWorkspaceFolders([{ uri: { fsPath: '/Users/dev/projet' } }]);
    vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValue(new Error('no such command'));
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await expect(makeBroker().requestReopen(entry())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
