import { join } from 'node:path';

export interface SpoolDirs {
  events: string;
  sessions: string;
  requests: string;
  rejected: string;
  backups: string;
}

/** Racine de l'état de koh-vibe. `KOH_VIBE_HOME` permet de l'isoler en test. */
export function kohVibeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KOH_VIBE_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(env['HOME'] ?? '', '.koh-vibe');
}

/**
 * L'ancien emplacement de l'état, avant que l'extension ne devienne Koh-Vibe.
 *
 * Suit le MÊME réglage d'isolation que `kohVibeHome` : sans ça, un test qui
 * redirige la racine verrait quand même le vrai `~/.koh-claude` de la machine,
 * et la migration s'exercerait sur les sessions réelles de l'utilisateur.
 */
export function legacyHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KOH_VIBE_LEGACY_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(env['HOME'] ?? '', '.koh-claude');
}

export function spoolDirs(home: string): SpoolDirs {
  const events = join(home, 'events');
  return {
    events,
    sessions: join(home, 'sessions'),
    requests: join(home, 'requests'),
    rejected: join(events, 'rejected'),
    backups: join(home, 'backups'),
  };
}

/**
 * Dernier instantané de la statusline, déposé par le pont. Un seul fichier
 * réécrit, jamais un spool : contrairement aux événements de hooks, seule la
 * valeur la plus récente a un sens — un historique de pourcentages périmés
 * n'apprendrait rien et grossirait sans fin.
 */
export function statusFile(home: string): string {
  return join(home, 'status.json');
}

/**
 * Le dernier relevé obtenu auprès d'Anthropic, mis en cache.
 *
 * Partagé entre fenêtres et éditeurs, comme le classement : sans lui, chaque
 * fenêtre interrogerait l'API de son côté toutes les quelques minutes, pour
 * afficher exactement la même chose.
 */
export function usageFile(home: string): string {
  return join(home, 'usage.json');
}

/**
 * Réglages du son, partagés entre éditeurs.
 *
 * Même raison que le classement : la même machine ne doit pas annoncer deux
 * carillons différents selon la fenêtre d'où on la regarde.
 */
export function settingsFile(home: string): string {
  return join(home, 'settings.json');
}

/** Fichier partagé du classement en dossiers, à la racine de l'état de koh-vibe. */
export function groupsFile(home: string): string {
  return join(home, 'groups.json');
}

/**
 * The recently closed conversations, shared between windows.
 *
 * Same reason as the folder layout: what one window has just closed must be
 * offered for reopening in all the others.
 */
export function closedFile(home: string): string {
  return join(home, 'closed.json');
}
