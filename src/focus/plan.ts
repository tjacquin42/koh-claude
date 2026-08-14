import type { Session } from '../events/types';
import { sessionLabel } from '../ui/labels';

export type FocusPlan =
  | { kind: 'command'; command: string; args: readonly string[] }
  | { kind: 'explain'; message: string };

/**
 * La seule règle qui décide quoi faire d'une session : vscode/desktop
 * révèlent un panneau, tout le reste — y compris une origine absente ou
 * invalide (une requête écrite par une version antérieure du broker) —
 * n'ouvre AUCUN contexte. Ouvrir une conversation que l'utilisateur n'a pas
 * demandée est précisément le défaut que ce lot corrige, donc `explain` est
 * le repli sûr, jamais une commande devinée.
 *
 * `origin` n'est pas typé `Origin` : le chemin distant (le broker qui
 * consomme une requête écrite par une autre fenêtre) ne dispose que de ce
 * qu'un fichier JSON non fiable a bien voulu porter, pas d'une `Session`.
 * `focusPlanFor` ci-dessous est le seul appelant qui, lui, a une valeur déjà
 * typée.
 */
export function focusPlan(sessionId: string, origin: unknown, label: string): FocusPlan {
  if (origin === 'vscode' || origin === 'desktop') {
    return { kind: 'command', command: 'claude-vscode.editor.open', args: [sessionId] };
  }
  const suffix = typeof origin === 'string' && origin.length > 0 ? ` (${origin})` : '';
  return {
    kind: 'explain',
    message: `Koh-Vibe : la session « ${label} » tourne hors de l'éditeur${suffix} — rien à ouvrir ici.`,
  };
}

/** Que faire quand on clique sur une session, depuis la fenêtre qui la revendique. */
export function focusPlanFor(s: Session): FocusPlan {
  return focusPlan(s.id, s.origin, sessionLabel(s));
}
