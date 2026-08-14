import type { Session } from '../events/types';

export type FocusPlan =
  | { kind: 'command'; command: string; args: readonly string[] }
  | { kind: 'explain'; message: string };

/**
 * Que faire quand on clique sur une session. Une origine sans panneau ne doit
 * ouvrir AUCUN contexte : ouvrir une conversation que l'utilisateur n'a pas
 * demandée est précisément le défaut que ce lot corrige.
 */
export function focusPlanFor(s: Session): FocusPlan {
  if (s.origin === 'vscode' || s.origin === 'desktop') {
    return { kind: 'command', command: 'claude-vscode.editor.open', args: [s.id] };
  }
  return {
    kind: 'explain',
    message: `Koh-Claude : cette session tourne hors de l'éditeur (${s.origin}) — rien à ouvrir ici.`,
  };
}
