import { HOOK_EVENTS } from '../events/types';

/** Marqueur qui rend nos entrées reconnaissables : le nom de fichier de notre bridge. */
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

// La forme exacte, et strictement celle-là, que `installHooks` écrit pour un
// `bridgePath` et un `event` donnés — voir la construction de `command` plus bas.
// Capturer le chemin une fois et le retrouver par rétro-référence (`\1`) garantit
// que les deux occurrences sont identiques, comme dans le gabarit d'origine.
const OUR_COMMAND_RE = new RegExp(
  `^/bin/sh -c '\\[ -x "([^"]+)" \\] && "\\1" (?:${HOOK_EVENTS.join('|')}); exit 0'$`,
);

/**
 * Une commande est à nous seulement si elle correspond, au caractère près, au gabarit
 * que nous écrivons nous-mêmes — jamais si elle le contient ou le mentionne en passant.
 * Un test de sous-chaîne classerait comme nôtre une commande étrangère qui enrobe notre
 * bridge (`sh -c 'autre-chose && ~/.koh-claude/bin/koh-claude-bridge'`) : elle serait
 * alors supprimée par `installHooks`/`uninstallHooks`, et invisible pour
 * `foreignFingerprint` puisqu'il partage ce même prédicat — les deux garde-fous
 * tomberaient ensemble. La reconnaissance exacte du gabarit referme les deux à la fois.
 *
 * `uninstallHooks` ne reçoit pas de `bridgePath` : reconnaître le gabarit structurel
 * (plutôt que comparer à une chaîne construite avec un `bridgePath` qu'on n'a pas) est
 * ce qui permet à cette fonction de fonctionner sans cet argument.
 */
function isOurs(h: unknown): boolean {
  if (!isRecord(h) || typeof h['command'] !== 'string') return false;
  const match = OUR_COMMAND_RE.exec(h['command']);
  if (!match) return false;
  const bridgePath = match[1];
  return bridgePath !== undefined && (bridgePath === KOH_MARKER || bridgePath.endsWith(`/${KOH_MARKER}`));
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
 * Empreinte de tout ce qui, dans l'arbre `hooks`, n'est pas à nous — y compris les
 * formes que nous ne savons pas classer, sérialisées telles quelles. Sert de garde-fou
 * côté script d'installation : si cette empreinte change après une transformation,
 * quelque chose qui n'est pas à nous a disparu, changé de place ou a été remplacé par
 * autre chose. Un compte ne peut pas prouver une conservation — deux arbres où une
 * commande étrangère a simplement changé d'événement, ou a été perdue en même temps
 * qu'une autre apparaissait, peuvent partager le même compte ; l'empreinte, elle,
 * diffère forcément puisque chaque élément est qualifié par sa position.
 *
 * Chaque élément est identifié par son ascendance en noms — `hooks` → nom de
 * l'événement → valeur du champ `matcher` de l'objet qui le contient quand il en a un
 * — jamais par un indice de tableau : un indice se déplace légitimement quand on
 * insère notre propre entrée, un nom d'événement ou un motif de matcher non.
 *
 * L'ascendance est encodée comme une **suite de segments**, sérialisée en un seul
 * `JSON.stringify` avec la valeur en dernier élément — jamais par concaténation avec
 * un séparateur. Une concaténation `"hooks." + event + "." + matcher` confond
 * `event = "PreToolUse.Bash"` avec `event = "PreToolUse", matcher = "Bash.foo"` dès que
 * l'un des deux contient le séparateur ; deux segments de tableau distincts se
 * sérialisent toujours différemment, quel que soit leur contenu.
 *
 * Parcours volontairement indépendant de `stripOurs`/`isMatcher` : si l'empreinte lisait
 * la structure de la même façon que la transformation qu'elle surveille, une forme que
 * cette lecture ne sait pas voir serait absente des deux côtés et le garde-fou
 * laisserait passer exactement le genre de perte qu'il doit attraper.
 *
 * Résidus assumés, documentés plutôt que cachés :
 * - Deux commandes étrangères qui échangent seulement leur ordre à l'intérieur du même
 *   matcher (donc sous la même clé d'ascendance) restent indiscernables, l'empreinte
 *   étant triée pour ignorer l'ordre d'énumération des clés d'objet.
 * - Deux blocs matcher qui partagent le même motif au sein du même événement partagent
 *   aussi la même clé d'ascendance : les commandes restent toutes présentes et
 *   qualifiées par la condition de déclenchement qu'elles partagent, mais on ne peut
 *   pas dire duquel des deux blocs chacune vient précisément.
 */
export function foreignFingerprint(settings: unknown): string[] {
  if (!isRecord(settings) || !isRecord(settings['hooks'])) return [];
  const out: string[] = [];

  const record = (path: readonly string[], value: unknown): void => {
    out.push(JSON.stringify([...path, value]));
  };

  const walkCommandList = (path: readonly string[], list: unknown[]): void => {
    for (const item of list) {
      if (isOurs(item)) continue;
      record(path, item);
    }
  };

  const walkMatcherArray = (path: readonly string[], list: unknown[]): void => {
    for (const item of list) {
      const itemPath =
        isRecord(item) && typeof item['matcher'] === 'string' ? [...path, item['matcher']] : path;
      if (isRecord(item) && Array.isArray(item['hooks'])) {
        walkCommandList(itemPath, item['hooks']);
      } else {
        record(itemPath, item);
      }
    }
  };

  for (const [event, value] of Object.entries(settings['hooks'])) {
    const path = ['hooks', event];
    if (Array.isArray(value)) {
      walkMatcherArray(path, value);
    } else {
      record(path, value);
    }
  }

  return out.sort();
}
