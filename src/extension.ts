import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { groupsFile, kohClaudeHome, spoolDirs } from './paths';
import { ensureDirs, readSessions } from './spool/persist';
import { SpoolWatcher } from './spool/watcher';
import { pruneAssignmentsAfterPurge } from './groups/purge';
import type { TranscriptStats } from './transcript/reader';
import { withTokens } from './transcript/tokens';
import { SessionsTree } from './ui/tree';
import { StatusSummary } from './ui/statusbar';
import { FocusBroker } from './focus/broker';
import { acknowledgeClickedSession, acknowledgeVisibleSessions } from './focus/acknowledge';
import { countKohEntries } from './hooks/installer';
import type { Session } from './events/types';
import { GUARD_TIMEOUT_MS, ReentrantGuard } from './lib/reentrant-guard';

const REFRESH_MS = 2_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const home = kohClaudeHome();
  const dirs = spoolDirs(home);
  const groupsPath = groupsFile(home);
  await ensureDirs(dirs);

  // Relu à chaque fois que l'arbre s'apprête à afficher son nœud vide (voir
  // SessionsTree), jamais mis en cache ici : le coût (une lecture de fichier)
  // n'est payé que dans le cas rare où il n'y a aucune session à montrer.
  async function checkHooksInstalled(): Promise<boolean> {
    try {
      const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8');
      return countKohEntries(JSON.parse(raw)) > 0;
    } catch {
      return false;
    }
  }

  const tree = new SessionsTree(checkHooksInstalled);
  const status = new StatusSummary();
  const broker = new FocusBroker(dirs);
  const transcripts = new Map<string, TranscriptStats>();

  const view = vscode.window.createTreeView('kohClaude.sessions', { treeDataProvider: tree });

  // Un seul avertissement par cause, jamais un par tick (le minuteur tourne
  // toutes les REFRESH_MS) : même précédent que `warnedMissingCommand` dans
  // FocusBroker.
  let transcriptFailureWarned = false;
  let renderFailureWarned = false;
  let drainFailureWarned = false;
  // Garde de réentrance factorisée (ReentrantGuard) : render() est déclenché
  // par trois sources indépendantes (minuteur, watcher, commande de
  // rafraîchissement), qui peuvent se chevaucher si un rendu est lent — même
  // motif que SpoolWatcher.tick() et FocusBroker.tick().
  const renderGuard = new ReentrantGuard(GUARD_TIMEOUT_MS);

  async function render(): Promise<void> {
    return renderGuard.run(
      async () => {
        const map = await withTokens(await readSessions(dirs), transcripts, () => {
          if (transcriptFailureWarned) return;
          transcriptFailureWarned = true;
          void vscode.window.showWarningMessage(
            "Koh-Claude : lecture d'un transcript impossible — cette session s'affiche sans ses compteurs.",
          );
        });
        tree.setSessions(map);
        status.update(map);
      },
      () => {
        // Filet générique : quelle que soit la cause restée hors de l'isolation
        // par session ci-dessus, ce rendu échoue seul — jamais les suivants. Le
        // minuteur, le watcher et la commande de rafraîchissement redéclenchent
        // tous render() indépendamment de cet échec.
        if (renderFailureWarned) return;
        renderFailureWarned = true;
        void vscode.window.showWarningMessage(
          'Koh-Claude : le rendu du tableau de bord a échoué — nouvelle tentative automatique.',
        );
      },
    );
  }

  const watcher = new SpoolWatcher(
    dirs,
    (res) => {
      // Une session purgée (24h sans événement, voir purgeStaleSessions) ne
      // doit pas laisser une entrée orpheline dans ce cache en mémoire :
      // sinon la purge sur disque ne borne rien côté mémoire.
      for (const id of res.purged) transcripts.delete(id);
      // Même principe côté classement en dossiers : l'affectation d'une
      // session purgée est un déchet sans nettoyage. pruneAssignmentsAfterPurge
      // n'écrit rien quand res.purged est vide (la quasi-totalité des tours).
      void pruneAssignmentsAfterPurge(dirs, groupsPath, res.purged).catch(() => undefined);
      void render();
    },
    () => {
      if (drainFailureWarned) return;
      drainFailureWarned = true;
      void vscode.window.showWarningMessage(
        'Koh-Claude : la lecture des événements a échoué — nouvelle tentative automatique.',
      );
    },
  );
  watcher.start();
  broker.start();

  function workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  // Acquitte les sessions terminées quand la vue devient visible dans cette
  // fenêtre — mais seulement celles que cette fenêtre revendique (spec §5).
  // acknowledgeVisibleSessions est testée directement (test/acknowledge.test.ts) :
  // le point d'appel lui-même, pas seulement la primitive pure qu'il utilise.
  const onVisible = view.onDidChangeVisibility(async (e) => {
    if (!e.visible) return;
    await acknowledgeVisibleSessions(dirs, workspaceFolders());
  });

  const ticker = setInterval(() => void render(), REFRESH_MS);

  // Chemin absolu : le terminal lancé par les deux commandes ci-dessous peut
  // avoir n'importe quel répertoire courant, le script n'en dépend pas.
  const installScript = join(context.extensionPath, 'scripts', 'install-hooks.cjs');

  context.subscriptions.push(
    view,
    tree,
    onVisible,
    status,
    { dispose: () => watcher.stop() },
    { dispose: () => broker.stop() },
    { dispose: () => clearInterval(ticker) },
    vscode.commands.registerCommand('kohClaude.refresh', () => void render()),
    vscode.commands.registerCommand('kohClaude.focusSession', (s: Session) => {
      // Le clic acquitte inconditionnellement (spec §5 : « clic sur la
      // session »), indépendamment de claims() — qui ne gouverne que
      // l'acquittement passif d'acknowledgeVisibleSessions, ci-dessus.
      // acknowledgeClickedSession est testée directement, comme sa jumelle.
      void acknowledgeClickedSession(dirs, s).catch(() => undefined);
      void broker.request(s).catch(() => undefined);
    }),
    vscode.commands.registerCommand('kohClaude.installHooks', () => {
      const terminal = vscode.window.createTerminal('Koh-Claude');
      terminal.sendText(`node "${installScript}"`);
      terminal.show();
    }),
    vscode.commands.registerCommand('kohClaude.uninstallHooks', () => {
      const terminal = vscode.window.createTerminal('Koh-Claude');
      terminal.sendText(`node "${installScript}" --uninstall`);
      terminal.show();
    }),
  );

  await render();
}

export function deactivate(): void {
  // Toutes les ressources sont enregistrées dans context.subscriptions.
}
