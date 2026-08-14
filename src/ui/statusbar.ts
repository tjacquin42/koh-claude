import * as vscode from 'vscode';
import type { Session } from '../events/types';
import { withStaleness } from '../store/staleness';

export class StatusSummary {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'kohVibe.sessions.focus';
    this.item.name = 'Koh-Vibe';
  }

  update(map: Map<string, Session>): void {
    const now = Date.now();
    const sessions = [...map.values()].map((s) => withStaleness(s, now));
    const waiting = sessions.filter((s) => s.status === 'waiting').length;
    const running = sessions.filter((s) => s.status === 'running').length;
    const done = sessions.filter((s) => s.status === 'done_unseen').length;

    if (sessions.length === 0) {
      this.item.hide();
      return;
    }

    const parts: string[] = [];
    // Même raison que la pastille de l'arbre : une session qui attend n'est pas
    // une panne.
    if (waiting > 0) parts.push(`$(question) ${waiting}`);
    if (running > 0) parts.push(`$(circle-filled) ${running}`);
    if (done > 0) parts.push(`$(check) ${done}`);
    this.item.text = parts.length > 0 ? parts.join(' · ') : `$(circle-outline) ${sessions.length}`;
    this.item.tooltip =
      sessions.length > 1
        ? vscode.l10n.t('Koh-Vibe — {0} sessions', sessions.length)
        : vscode.l10n.t('Koh-Vibe — {0} session', sessions.length);
    this.item.backgroundColor =
      waiting > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
