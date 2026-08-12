import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { SpoolDirs } from '../paths';
import type { Session } from '../events/types';
import { claims } from './claims';

const FOCUS_COMMAND = 'claude-vscode.editor.openLast';

export class FocusBroker {
  private watcher: FSWatcher | undefined;

  constructor(private readonly dirs: SpoolDirs) {}

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  /** Demande le focus d'une session, où qu'elle vive. */
  async request(s: Session): Promise<void> {
    if (claims(this.folders(), s.cwd)) {
      await this.focusHere();
      return;
    }
    const name = join(this.dirs.requests, `focus-${s.id}.json`);
    await writeFile(name, JSON.stringify({ sessionId: s.id, cwd: s.cwd, at: Date.now() }), 'utf8');

    // Si personne ne l'a consommée, aucune fenêtre ne détient ce projet : on l'ouvre.
    setTimeout(() => {
      void readFile(name, 'utf8').then(
        async () => {
          await unlink(name).catch(() => undefined);
          execFile('code', ['-r', s.cwd], () => undefined);
        },
        () => undefined, // consommée : rien à faire
      );
    }, 2_000);
  }

  private async focusHere(): Promise<void> {
    try {
      await vscode.commands.executeCommand(FOCUS_COMMAND);
    } catch {
      void vscode.window.showWarningMessage(
        "Koh-Claude : l'extension Claude Code n'expose pas de commande de focus dans cette version.",
      );
    }
  }

  start(): void {
    this.watcher = watch(this.dirs.requests, () => {
      void this.consume();
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Ne consomme que les requêtes qui concernent les dossiers de cette fenêtre. */
  private async consume(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dirs.requests);
    } catch {
      return;
    }
    const folders = this.folders();
    for (const name of names.filter((n) => n.startsWith('focus-'))) {
      const path = join(this.dirs.requests, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        const cwd = (parsed as { cwd?: unknown }).cwd;
        if (typeof cwd !== 'string' || !claims(folders, cwd)) continue;
        await unlink(path);
        await vscode.window.showInformationMessage('Koh-Claude : session demandée');
        await this.focusHere();
      } catch {
        continue;
      }
    }
  }
}
