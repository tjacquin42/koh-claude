import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { SpoolDirs } from '../paths';
import type { Session } from '../events/types';
import { claims } from './claims';
import { sessionLabel } from '../ui/labels';
import { GUARD_TIMEOUT_MS, ReentrantGuard } from '../lib/reentrant-guard';

const FOCUS_COMMAND = 'claude-vscode.editor.openLast';

// Une requête plus vieille que ce délai n'est plus honorée : elle serait
// consommée hors de tout contexte (ex : par le filet périodique, ou par un
// événement fs.watch sans rapport), ce qui ferait sauter une fenêtre au
// premier plan sans que l'utilisateur ait rien cliqué.
const STALE_REQUEST_MS = 30_000;

export class FocusBroker {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly guard = new ReentrantGuard(GUARD_TIMEOUT_MS);
  private warnedMissingCommand = false;
  private consumeFailureWarned = false;
  private readonly fallbacks = new Map<string, NodeJS.Timeout>();
  // `process.pid` est constant sur toute la durée de vie du process de
  // l'extension (contrairement au bridge, où un process équivaut à un appel) :
  // un compteur incrémenté en synchrone à chaque appel de `request` l'est,
  // même pour deux clics sans `await` entre eux — même défaut, même
  // traitement qu'`appendLocalEvent` (spool/watcher.ts).
  private requestSeq = 0;

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
    const seq = (this.requestSeq += 1);
    const name = join(this.dirs.requests, `focus-${s.id}.json`);
    const tmp = join(this.dirs.requests, `.tmp-${s.id}-${process.pid}-${seq}`);
    const body = JSON.stringify({ sessionId: s.id, cwd: s.cwd, label: sessionLabel(s), at: Date.now() });
    // Fichier temporaire puis renommage : une autre fenêtre réveillée par le
    // même fs.watch ne doit jamais lire un fichier partiel.
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, name);

    // Un second clic sur la même session avant l'expiration du premier repli
    // ne doit pas laisser le premier minuteur courir sans plus être suivi
    // dans `fallbacks` : `stop()` ne verrait plus que le second, et le
    // premier pourrait lancer `code -r` après la libération de l'extension.
    const existing = this.fallbacks.get(s.id);
    if (existing !== undefined) clearTimeout(existing);

    // Si personne ne l'a consommée, aucune fenêtre ne détient ce projet : on l'ouvre.
    const timer = setTimeout(() => {
      this.fallbacks.delete(s.id);
      void readFile(name, 'utf8').then(
        async () => {
          await unlink(name).catch(() => undefined);
          execFile('code', ['-r', s.cwd], () => undefined);
        },
        () => undefined, // consommée : rien à faire
      );
    }, 2_000);
    this.fallbacks.set(s.id, timer);
  }

  private async focusHere(): Promise<void> {
    try {
      await vscode.commands.executeCommand(FOCUS_COMMAND);
    } catch {
      // Un avertissement par session d'extension suffit : répété à chaque
      // clic, il devient du bruit qu'on apprend à ignorer.
      if (!this.warnedMissingCommand) {
        this.warnedMissingCommand = true;
        void vscode.window.showWarningMessage(
          "Koh-Claude : l'extension Claude Code n'expose pas de commande de focus dans cette version.",
        );
      }
    }
  }

  start(): void {
    void this.tick();
    try {
      this.watcher = watch(this.dirs.requests, () => this.schedule());
    } catch {
      // Le dossier n'existe pas encore (ex : ensureDirs pas encore passé sur
      // cette machine). Le filet périodique ci-dessous prend le relais dès
      // qu'il apparaîtra.
      this.watcher = undefined;
    }
    // Filet : fs.watch peut manquer des événements sur certains volumes.
    this.timer = setInterval(() => this.schedule(), 5_000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of this.fallbacks.values()) clearTimeout(t);
    this.fallbacks.clear();
  }

  private schedule(): void {
    void this.tick();
  }

  private tick(): Promise<void> {
    return this.guard.run(
      () => this.consume(),
      () => {
        // Un avertissement par cause suffit : même précédent que
        // `warnedMissingCommand` ci-dessus.
        if (this.consumeFailureWarned) return;
        this.consumeFailureWarned = true;
        void vscode.window.showWarningMessage(
          'Koh-Claude : la consommation des requêtes de focus a échoué — nouvelle tentative automatique.',
        );
      },
    );
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
    const now = Date.now();
    for (const name of names.filter((n) => n.startsWith('focus-'))) {
      const path = join(this.dirs.requests, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        const at = (parsed as { at?: unknown }).at;
        if (typeof at === 'number' && now - at > STALE_REQUEST_MS) {
          // Trop vieille pour être honorée hors contexte : on l'écarte sans
          // déclencher de focus.
          await unlink(path);
          continue;
        }
        const cwd = (parsed as { cwd?: unknown }).cwd;
        if (typeof cwd !== 'string' || !claims(folders, cwd)) continue;
        await unlink(path);
        const rawLabel = (parsed as { label?: unknown }).label;
        const label = typeof rawLabel === 'string' && rawLabel.length > 0 ? rawLabel : 'session';
        // `void`, jamais `await` : ce thenable ne se règle qu'à la fermeture
        // du toast (clic ou disparition), parfois des secondes plus tard. Le
        // focus est le geste central du clic (spec §6) ; le message n'est
        // qu'une information, il ne doit jamais le retarder.
        void vscode.window.showInformationMessage(`Koh-Claude : session « ${label} » demandée`);
        await this.focusHere();
      } catch {
        continue;
      }
    }
  }
}
