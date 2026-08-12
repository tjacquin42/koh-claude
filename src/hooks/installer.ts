import { HOOK_EVENTS } from '../events/types';

/** Marqueur qui rend nos entrées reconnaissables pour la désinstallation. */
export const KOH_MARKER = 'koh-claude-bridge';

interface HookCommand {
  type: 'command';
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function matchers(v: unknown): HookMatcher[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is HookMatcher => isRecord(e) && Array.isArray(e['hooks']));
}

function isOurs(h: unknown): boolean {
  return isRecord(h) && typeof h['command'] === 'string' && h['command'].includes(KOH_MARKER);
}

/**
 * Ajoute nos entrées sans toucher aux autres. Notre commande n'a jamais de
 * `timeout` : un hook `PermissionRequest` bloquant déciderait à la place de
 * l'utilisateur et entrerait en concurrence avec celui de Vibe Island.
 */
export function installHooks(settings: unknown, bridgePath: string): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  const hooks = isRecord(root['hooks']) ? { ...root['hooks'] } : {};

  for (const event of HOOK_EVENTS) {
    const existing = matchers(hooks[event]).map((e) => ({
      ...e,
      hooks: e.hooks.filter((h) => !isOurs(h)),
    }));
    const command = `/bin/sh -c '[ -x "${bridgePath}" ] && "${bridgePath}" ${event}; exit 0'`;
    hooks[event] = [
      ...existing.filter((e) => e.hooks.length > 0),
      { matcher: '*', hooks: [{ type: 'command', command }] },
    ];
  }

  root['hooks'] = hooks;
  return root;
}

export function uninstallHooks(settings: unknown): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  if (!isRecord(root['hooks'])) return root;
  const hooks: Record<string, unknown> = {};

  for (const [event, value] of Object.entries(root['hooks'])) {
    const kept = matchers(value)
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isOurs(h)) }))
      .filter((e) => e.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }

  root['hooks'] = hooks;
  return root;
}

export function countKohEntries(settings: unknown): number {
  if (!isRecord(settings) || !isRecord(settings['hooks'])) return 0;
  let n = 0;
  for (const value of Object.values(settings['hooks'])) {
    for (const entry of matchers(value)) n += entry.hooks.filter(isOurs).length;
  }
  return n;
}
