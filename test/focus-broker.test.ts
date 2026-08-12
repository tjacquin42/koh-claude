import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs } from '../src/spool/persist';
import { FocusBroker } from '../src/focus/broker';
import type { Session } from '../src/events/types';

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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'koh-broker-'));
  dirs = spoolDirs(home);
  await ensureDirs(dirs);
  vscode.workspace.workspaceFolders = undefined;
  vi.restoreAllMocks();
  brokers = [];
});

afterEach(() => {
  for (const b of brokers) b.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('FocusBroker.request', () => {
  it('focalise directement la fenêtre courante quand elle revendique la session, sans écrire de requête', async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/Users/dev/projet' } }];
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const broker = makeBroker();

    await broker.request(session());

    expect(executeCommand).toHaveBeenCalledWith('claude-vscode.editor.openLast');
  });

  it("écrit un fichier de requête portant le libellé de la session (sessionLabel) quand aucune fenêtre ne la revendique", async () => {
    const broker = makeBroker();

    await broker.request(session({ id: 's-remote', branch: 'feat-x' }));

    const raw = await readFile(join(dirs.requests, 'focus-s-remote.json'), 'utf8');
    const parsed = JSON.parse(raw) as { sessionId: string; cwd: string; label: string };
    expect(parsed.sessionId).toBe('s-remote');
    expect(parsed.label).toBe('feat-x'); // sessionLabel() préfère la branche au projet
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
      return new Promise<string | undefined>(() => undefined);
    });
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async () => {
      focusCalled = true;
      return undefined;
    });
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/Users/dev/projet' } }];

    // La requête est écrite pendant que personne ne revendie encore (dossier
    // vide), pour forcer l'écriture d'un fichier plutôt qu'un focus direct.
    vscode.workspace.workspaceFolders = undefined;
    const other = makeBroker();
    await other.request(session({ id: 's-cross' }));

    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/Users/dev/projet' } }];
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(messageCalled).toBe(true);
    expect(focusCalled).toBe(true);
  });

  it('nomme la session dans le message plutôt que rester générique (mineur T11)', async () => {
    let message: unknown;
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((m: unknown) => {
      message = m;
      return new Promise<string | undefined>(() => undefined);
    });
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const other = makeBroker();
    await other.request(session({ id: 's-cross', branch: 'feat-x' }));

    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/Users/dev/projet' } }];
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

    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/Users/dev/autre-projet' } }];
    const broker = makeBroker();
    const internal = broker as unknown as { consume: () => Promise<void> };
    await internal.consume();

    expect(executeCommand).not.toHaveBeenCalled();
  });
});
