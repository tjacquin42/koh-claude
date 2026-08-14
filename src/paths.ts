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
 * Le cache d'usage de Vibe Island, lu s'il existe.
 *
 * Pourquoi une seconde source : Claude Code ne passe `rate_limits` qu'à la
 * statusline, et la statusline ne tourne pas dans une session hébergée par
 * l'éditeur — notre propre instantané reste donc vide tant qu'on n'a pas lancé
 * une session en terminal. Vibe Island, lui, interroge l'API et rafraîchit ce
 * fichier en continu.
 *
 * Lecture opportuniste, jamais une dépendance : le fichier appartient à un autre
 * produit, son format peut changer sans prévenir, et son absence est le cas
 * normal pour qui n'a pas Vibe Island. Il est donc validé comme n'importe quelle
 * donnée venue de l'extérieur, et son absence ne vaut jamais une erreur.
 */
export function vibeIslandUsageFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KOH_VIBE_ISLAND_USAGE'];
  if (override !== undefined && override.length > 0) return override;
  return join(env['HOME'] ?? '', '.vibe-island', 'cache', 'usage-persist.json');
}

/** Fichier partagé du classement en dossiers, à la racine de l'état de koh-vibe. */
export function groupsFile(home: string): string {
  return join(home, 'groups.json');
}
