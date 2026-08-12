export type Status = 'running' | 'waiting' | 'done_unseen' | 'idle' | 'stale';
export type Origin = 'vscode' | 'terminal' | 'desktop' | 'sdk' | 'unknown';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Événements produits par l'extension elle-même, déposés dans le même spool. */
export const LOCAL_EVENTS = ['Ack'] as const;
export type LocalEvent = (typeof LOCAL_EVENTS)[number];

export type EventName = HookEvent | LocalEvent;

/** Événement normalisé : le réducteur ne voit jamais un payload brut. */
export interface SpoolEvent {
  event: EventName;
  at: number;
  entrypoint: string;
  termProgram: string;
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  toolName?: string;
  toolTarget?: string;
  message?: string;
}

export interface Session {
  id: string;
  cwd: string;
  project: string;
  branch?: string;
  origin: Origin;
  status: Status;
  currentAction?: { tool: string; target?: string };
  pendingPermission?: { tool: string; summary: string };
  /** Posé au PreToolUse, retiré au PostToolUse. Suspend la péremption. */
  inFlightSince?: number;
  toolCount: number;
  tokens?: { input: number; output: number };
  startedAt?: number;
  lastEventAt: number;
  transcriptPath?: string;
}
