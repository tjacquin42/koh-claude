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

/** Une entrée de matcher reconnue : un objet dont `hooks` est un tableau. */
function isMatcher(v: unknown): v is HookMatcher {
  return isRecord(v) && Array.isArray(v['hooks']);
}

function isOurs(h: unknown): boolean {
  return isRecord(h) && typeof h['command'] === 'string' && h['command'].includes(KOH_MARKER);
}

/**
 * Retire nos commandes d'une entrée de matcher reconnue. Toute valeur qui n'est pas
 * une entrée de matcher reconnue (forme inattendue : `hooks` absent, pas un tableau,
 * entrée qui n'est même pas un objet…) n'est pas à nous — elle traverse intacte, à sa
 * place, plutôt que de disparaître silencieusement.
 */
function stripOurs(item: unknown): unknown[] {
  if (!isMatcher(item)) return [item];
  const hooksLeft = item.hooks.filter((h) => !isOurs(h));
  return hooksLeft.length > 0 ? [{ ...item, hooks: hooksLeft }] : [];
}

/**
 * Ajoute nos entrées sans toucher aux autres. Notre commande n'a jamais de
 * `timeout` : un hook `PermissionRequest` bloquant déciderait à la place de
 * l'utilisateur et entrerait en concurrence avec celui de Vibe Island.
 *
 * Si la valeur existante d'un événement n'est pas un tableau (forme que nous ne
 * reconnaissons pas), on ne la remplace pas : impossible d'y ajouter notre entrée
 * sans écraser une donnée qui n'est pas à nous, donc on la laisse telle quelle et on
 * n'installe rien pour cet événement précis.
 */
export function installHooks(settings: unknown, bridgePath: string): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  const hooks = isRecord(root['hooks']) ? { ...root['hooks'] } : {};

  for (const event of HOOK_EVENTS) {
    const value = hooks[event];
    if (value !== undefined && !Array.isArray(value)) continue;

    const list = Array.isArray(value) ? value : [];
    const command = `/bin/sh -c '[ -x "${bridgePath}" ] && "${bridgePath}" ${event}; exit 0'`;
    const ourEntry: HookMatcher = { matcher: '*', hooks: [{ type: 'command', command }] };
    hooks[event] = [...list.flatMap(stripOurs), ourEntry];
  }

  root['hooks'] = hooks;
  return root;
}

/**
 * Retire nos entrées sans toucher aux autres. Un événement dont la valeur n'est pas
 * un tableau (forme que nous ne reconnaissons pas) est repris tel quel. Un événement
 * qui, une fois nos entrées retirées, ne contient plus rien du tout — ni à nous ni à
 * personne d'autre — est omis pour ne pas laisser traîner un tableau vide.
 */
export function uninstallHooks(settings: unknown): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  if (!isRecord(root['hooks'])) return root;
  const hooks: Record<string, unknown> = {};

  for (const [event, value] of Object.entries(root['hooks'])) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const kept = value.flatMap(stripOurs);
    if (kept.length > 0) hooks[event] = kept;
  }

  root['hooks'] = hooks;
  return root;
}

export function countKohEntries(settings: unknown): number {
  if (!isRecord(settings) || !isRecord(settings['hooks'])) return 0;
  let n = 0;
  for (const value of Object.values(settings['hooks'])) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isMatcher(entry)) n += entry.hooks.filter(isOurs).length;
    }
  }
  return n;
}

/**
 * Compte, où qu'elles se trouvent dans l'arbre `hooks`, les commandes qui ne sont pas
 * les nôtres — y compris nichées dans une forme que nous ne reconnaissons pas (par
 * exemple un `hooks` qui n'est pas un tableau mais contient tout de même un objet
 * `{ command }`). Sert de garde-fou côté script d'installation : si ce nombre change
 * après une transformation, quelque chose qui n'est pas à nous a disparu.
 */
export function countForeignEntries(settings: unknown): number {
  if (!isRecord(settings) || !isRecord(settings['hooks'])) return 0;
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (!isRecord(v)) return;
    if (typeof v['command'] === 'string' && !isOurs(v)) n += 1;
    for (const value of Object.values(v)) walk(value);
  };
  walk(settings['hooks']);
  return n;
}
