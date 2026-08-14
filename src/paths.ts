import { join } from 'node:path';

export interface SpoolDirs {
  events: string;
  sessions: string;
  requests: string;
  rejected: string;
  backups: string;
}

/** Racine de l'état de koh-claude. `KOH_CLAUDE_HOME` permet de l'isoler en test. */
export function kohClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KOH_CLAUDE_HOME'];
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

/** Fichier partagé du classement en dossiers, à la racine de l'état de koh-claude. */
export function groupsFile(home: string): string {
  return join(home, 'groups.json');
}
