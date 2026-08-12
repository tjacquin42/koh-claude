import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { kohClaudeHome, spoolDirs } from './paths';
import { ensureDirs, readSessions } from './spool/persist';
import { appendLocalEvent, SpoolWatcher } from './spool/watcher';
import { readTranscript, type TranscriptStats } from './transcript/reader';
import { SessionsTree } from './ui/tree';
import { StatusSummary } from './ui/statusbar';
import { FocusBroker } from './focus/broker';
import { countKohEntries } from './hooks/installer';
import type { Session } from './events/types';

const REFRESH_MS = 2_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dirs = spoolDirs(kohClaudeHome());
  await ensureDirs(dirs);

  const tree = new SessionsTree();
  const status = new StatusSummary();
  const broker = new FocusBroker(dirs);
  const transcripts = new Map<string, TranscriptStats>();

  const view = vscode.window.createTreeView('kohClaude.sessions', { treeDataProvider: tree });

  async function withTokens(map: Map<string, Session>): Promise<Map<string, Session>> {
    for (const s of map.values()) {
      if (s.transcriptPath === undefined) continue;
      const stats = await readTranscript(s.transcriptPath, transcripts.get(s.id));
      transcripts.set(s.id, stats);
      s.tokens = { input: stats.input, output: stats.output };
      if (s.branch === undefined && stats.branch !== undefined) s.branch = stats.branch;
    }
    return map;
  }

  async function render(): Promise<void> {
    const map = await withTokens(await readSessions(dirs));
    tree.setSessions(map);
    status.update(map);
  }

  const watcher = new SpoolWatcher(dirs, () => void render());
  watcher.start();
  broker.start();

  // Acquitte les sessions terminées quand la vue devient visible dans cette fenêtre.
  const onVisible = view.onDidChangeVisibility(async (e) => {
    if (!e.visible) return;
    for (const s of (await readSessions(dirs)).values()) {
      if (s.status === 'done_unseen') {
        await appendLocalEvent(dirs, { event: 'Ack', sessionId: s.id, cwd: s.cwd });
      }
    }
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
    vscode.commands.registerCommand('kohClaude.focusSession', (s: Session) => void broker.request(s)),
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

  // État initial : hooks installés ou non. Les deux commandes ci-dessus passent par
  // un terminal externe, qui ne renvoie aucun signal à l'extension à la fin de la
  // commande : refléter l'état après coup demanderait de surveiller settings.json,
  // hors périmètre de cette tâche.
  try {
    const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8');
    tree.setHooksInstalled(countKohEntries(JSON.parse(raw)) > 0);
  } catch {
    tree.setHooksInstalled(false);
  }

  await render();
}

export function deactivate(): void {
  // Toutes les ressources sont enregistrées dans context.subscriptions.
}
