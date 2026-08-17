import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { SpoolDirs } from '../paths';
import type { Session } from '../events/types';
import type { ClosedEntry } from '../closed/model';
import { claims } from './claims';
import { focusPlan, focusPlanFor, type FocusPlan } from './plan';
import { reopenPlan } from '../closed/reopen';
import { closePlan } from '../close/plan';
import { sessionLabel } from '../ui/labels';
import { GUARD_TIMEOUT_MS, ReentrantGuard } from '../lib/reentrant-guard';

// Une requête plus vieille que ce délai n'est plus honorée : elle serait
// consommée hors de tout contexte (ex : par le filet périodique, ou par un
// événement fs.watch sans rapport), ce qui ferait sauter une fenêtre au
// premier plan sans que l'utilisateur ait rien cliqué.
const STALE_REQUEST_MS = 30_000;

/**
 * What the broker cannot do by itself. It knows nothing of the spool, of the
 * closed-conversation history or of the folder layout — `extension.ts` hands
 * it these two, exactly as it hands `SpoolWatcher` its `archive` callback.
 */
export interface CloseHandlers {
  /** Closes the tab here, then archives and removes the row per the outcome. */
  closeHere: (sessionId: string) => Promise<void>;
  /** Removes the row, closing nothing and archiving nothing. */
  forget: (sessionId: string) => Promise<void>;
}

export class FocusBroker {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly guard = new ReentrantGuard(GUARD_TIMEOUT_MS);
  // Two flags, not one: a warning already shown for a focus click must not
  // silence the one a reopen click deserves later, and vice versa — a user
  // who dismissed the focus warning would otherwise get nothing at all for
  // every reopen click that follows, on a section whose only gesture IS
  // reopening.
  private warnedMissingFocusCommand = false;
  private warnedMissingReopenCommand = false;
  private consumeFailureWarned = false;
  private readonly fallbacks = new Map<string, NodeJS.Timeout>();
  // `process.pid` est constant sur toute la durée de vie du process de
  // l'extension (contrairement au bridge, où un process équivaut à un appel) :
  // un compteur incrémenté en synchrone à chaque appel de `request` l'est,
  // même pour deux clics sans `await` entre eux — même défaut, même
  // traitement qu'`appendLocalEvent` (spool/watcher.ts).
  private requestSeq = 0;

  constructor(
    private readonly dirs: SpoolDirs,
    private readonly close: CloseHandlers,
  ) {}

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  /** Demande le focus d'une session, où qu'elle vive. */
  async request(s: Session): Promise<void> {
    if (claims(this.folders(), s.cwd)) {
      await this.focusSession(focusPlanFor(s), 'focus');
      return;
    }
    const seq = (this.requestSeq += 1);
    const name = join(this.dirs.requests, `focus-${s.id}.json`);
    const tmp = join(this.dirs.requests, `.tmp-${s.id}-${process.pid}-${seq}`);
    const body = JSON.stringify({
      sessionId: s.id,
      cwd: s.cwd,
      label: sessionLabel(s),
      origin: s.origin,
      at: Date.now(),
    });
    // Fichier temporaire puis renommage : une autre fenêtre réveillée par le
    // même fs.watch ne doit jamais lire un fichier partiel.
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, name);

    // Un second clic sur la même session avant l'expiration du premier repli
    // ne doit pas laisser le premier minuteur courir sans plus être suivi
    // dans `fallbacks` : `stop()` ne verrait plus que le second, et le
    // premier pourrait lancer `code -r` après la libération de l'extension.
    //
    // Clé : le nom du fichier de requête, pas `s.id`. Une session focalisée
    // et une conversation rouverte peuvent partager le même id — le fichier
    // les distingue déjà (`focus-` contre `reopen-`), l'id seul ne le ferait
    // pas et un `set` écraserait l'entrée de l'autre.
    const existing = this.fallbacks.get(name);
    if (existing !== undefined) clearTimeout(existing);

    // Si personne ne l'a consommée, aucune fenêtre ne détient ce projet : on l'ouvre.
    const timer = setTimeout(() => {
      this.fallbacks.delete(name);
      void readFile(name, 'utf8').then(
        async () => {
          await unlink(name).catch(() => undefined);
          execFile('code', ['-r', s.cwd], () => undefined);
        },
        () => undefined, // consommée : rien à faire
      );
    }, 2_000);
    this.fallbacks.set(name, timer);
  }

  /**
   * Asks for a closed conversation to come back.
   *
   * Only the editor path travels: the Claude Code extension resolves the
   * working folder of a resumed session from the WINDOW's `workspaceFolders`,
   * not from the id, so reopening from a window that does not hold the project
   * would silently resume the conversation against the wrong one. A terminal
   * reopen has no such constraint — `createTerminal` takes the folder
   * explicitly — and is handled by the caller, locally, before we are reached.
   */
  async requestReopen(entry: ClosedEntry): Promise<void> {
    const plan = reopenPlan(entry.origin, entry.id, entry.cwd, sessionLabel(entry));
    if (plan.kind === 'terminal') {
      // The caller opens the terminal locally, before requestReopen is even
      // called: createTerminal takes the folder explicitly, so this branch
      // never needs another window — there is nothing left to do here.
      return;
    }
    if (plan.kind === 'explain') {
      // No window can reopen this — the blocker is the entry's ORIGIN (e.g.
      // sdk, unknown), not which one claims the folder. `reopenPlan` would
      // still return `explain` from any window, so travelling to another one
      // — writing a request file, arming the "no window has it open" fallback
      // — would only move the same refusal somewhere the user is not looking.
      void vscode.window.showInformationMessage(plan.message);
      return;
    }
    if (claims(this.folders(), entry.cwd)) {
      // Only `command` reaches here now. Going through `focusSession` rather
      // than calling `executeCommand` directly gives this local path the same
      // one-time missing-command warning as the remote one below.
      await this.focusSession(plan, 'reopen');
      return;
    }
    const seq = (this.requestSeq += 1);
    const name = join(this.dirs.requests, `reopen-${entry.id}.json`);
    const tmp = join(this.dirs.requests, `.tmp-reopen-${entry.id}-${process.pid}-${seq}`);
    const body = JSON.stringify({
      sessionId: entry.id,
      cwd: entry.cwd,
      label: sessionLabel(entry),
      origin: entry.origin,
      at: Date.now(),
    });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, name);

    // Fallback deliberately different from the focus one: NO `code -r`.
    // Opening the window would lose the reopen itself — we say so, and do
    // nothing else.
    const existing = this.fallbacks.get(name);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.fallbacks.delete(name);
      void readFile(name, 'utf8').then(
        async () => {
          await unlink(name).catch(() => undefined);
          void vscode.window.showInformationMessage(
            vscode.l10n.t('Koh-Vibe: no window has {0} open — open it, then reopen the conversation.', entry.cwd),
          );
        },
        () => undefined, // consommée : rien à faire
      );
    }, 2_000);
    this.fallbacks.set(name, timer);
  }

  /**
   * Asks for a conversation's tab to be closed.
   *
   * Only the window that holds the project can do it: a tab lives in one
   * window, and `claude-vscode.editor.open` — the sole way to designate a
   * session's panel — would CREATE one anywhere else.
   *
   * The caller has already ruled out every non-editor origin and asked for
   * confirmation where it was due (`requestCloseSession`, close/close.ts).
   */
  async requestClose(s: Session): Promise<void> {
    if (claims(this.folders(), s.cwd)) {
      await this.close.closeHere(s.id);
      return;
    }
    const seq = (this.requestSeq += 1);
    const name = join(this.dirs.requests, `close-${s.id}.json`);
    const tmp = join(this.dirs.requests, `.tmp-close-${s.id}-${process.pid}-${seq}`);
    const body = JSON.stringify({
      sessionId: s.id,
      cwd: s.cwd,
      label: sessionLabel(s),
      origin: s.origin,
      at: Date.now(),
    });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, name);

    const existing = this.fallbacks.get(name);
    if (existing !== undefined) clearTimeout(existing);
    // Fallback different from both others: no `code -r` (opening a window to
    // close a tab in it makes no sense) and no message. Nobody consumed the
    // request, so no window holds the project, so no tab can exist — which is
    // exactly the "no tab found" case, and its rule is to remove the row.
    const timer = setTimeout(() => {
      this.fallbacks.delete(name);
      void readFile(name, 'utf8').then(
        async () => {
          await unlink(name).catch(() => undefined);
          await this.close.forget(s.id).catch(() => undefined);
        },
        () => undefined, // consommée : rien à faire
      );
    }, 2_000);
    this.fallbacks.set(name, timer);
  }

  private async focusSession(plan: FocusPlan, gesture: 'focus' | 'reopen'): Promise<void> {
    if (plan.kind === 'explain') {
      void vscode.window.showInformationMessage(plan.message);
      return;
    }
    try {
      await vscode.commands.executeCommand(plan.command, ...plan.args);
    } catch {
      // Un avertissement par session d'extension suffit : répété à chaque
      // clic, il devient du bruit qu'on apprend à ignorer. Un par geste, pas
      // un seul pour les deux — voir le commentaire sur les deux champs.
      const alreadyWarned = gesture === 'focus' ? this.warnedMissingFocusCommand : this.warnedMissingReopenCommand;
      if (alreadyWarned) return;
      if (gesture === 'focus') this.warnedMissingFocusCommand = true;
      else this.warnedMissingReopenCommand = true;
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Koh-Vibe: the Claude Code extension does not expose a command to open a conversation in this version.',
        ),
      );
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
        // Un avertissement par cause suffit : même précédent que les drapeaux
        // `warnedMissingFocusCommand`/`warnedMissingReopenCommand` ci-dessus.
        if (this.consumeFailureWarned) return;
        this.consumeFailureWarned = true;
        void vscode.window.showWarningMessage(
          'Koh-Vibe : la consommation des requêtes de focus a échoué — nouvelle tentative automatique.',
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
    for (const name of names.filter(
      (n) => n.startsWith('focus-') || n.startsWith('reopen-') || n.startsWith('close-'),
    )) {
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
        const sessionId = (parsed as { sessionId?: unknown }).sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
        // This window only has what the request carries, not the Session
        // object: the plan is rebuilt via `focusPlan`/`reopenPlan`, the same
        // rule as the local path, never a copy that could drift. `cwd` is
        // already proven to be a `string` earlier in the loop — otherwise the
        // request would have been ignored before reaching here.
        const origin = (parsed as { origin?: unknown }).origin;
        if (name.startsWith('close-')) {
          // A close request should never carry a non-editor origin: `closePlan`
          // turns those into a plain forget before any file is written.
          // Honouring one would close a tab in a window where the user asked
          // for nothing. No message on success, unlike focus and reopen: the
          // effect is already visible on both sides — a tab disappears here, a
          // row disappears where the click happened.
          if (closePlan(origin).kind === 'tab') {
            // A failure here must still be surfaced: the request file is
            // already unlinked and the clicking window's own fallback has
            // already found nothing, so silence on both ends would leave the
            // user with no idea anything went wrong. `catch`, not the outer
            // `try`/`catch` below — that one exists to keep one bad request
            // from stopping the whole loop, and would swallow this in total
            // silence. Same message as the local path (extension.ts,
            // kohVibe.closeSession).
            await this.close.closeHere(sessionId).catch(() => {
              void vscode.window.showErrorMessage(vscode.l10n.t('Koh-Vibe: could not close « {0} ».', label));
            });
          }
          continue;
        }
        const isReopen = name.startsWith('reopen-');
        const plan = isReopen ? reopenPlan(origin, sessionId, cwd, label) : focusPlan(sessionId, origin, label);
        if (plan.kind === 'terminal') {
          // A reopen request should never carry a terminal origin: that case
          // is handled locally, without going through a file. Honouring this
          // one would open a terminal in a window where the user asked for
          // nothing.
          continue;
        }
        // Une seule annonce, jamais deux qui se contrediraient : « demandée »
        // (ou « réouverte ») devant une commande qui va effectivement ouvrir
        // quelque chose, l'explication de `focusSession` sinon.
        //
        // `void`, jamais `await` : ce thenable ne se règle qu'à la fermeture
        // du toast (clic ou disparition), parfois des secondes plus tard. Le
        // focus est le geste central du clic (spec §6) ; le message n'est
        // qu'une information, il ne doit jamais le retarder.
        if (plan.kind === 'command') {
          void vscode.window.showInformationMessage(
            isReopen
              ? vscode.l10n.t('Koh-Vibe: reopening « {0} »', label)
              : vscode.l10n.t('Koh-Vibe: « {0} » requested', label),
          );
        }
        await this.focusSession(plan, isReopen ? 'reopen' : 'focus');
      } catch {
        continue;
      }
    }
  }
}
