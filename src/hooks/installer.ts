import { HOOK_EVENTS } from '../events/types';

/** Marqueur qui rend nos entrées reconnaissables : le nom de fichier de notre bridge. */
export const KOH_MARKER = 'koh-vibe-bridge';

/**
 * L'ancien nom, avant que l'extension ne devienne Koh-Vibe.
 *
 * Il DOIT rester reconnu : les entrées posées par une version précédente vivent
 * encore dans le settings.json de ceux qui l'avaient installée. Ne plus les voir
 * ne les effacerait pas — elles deviendraient des orphelines qu'aucune
 * désinstallation ne retire, et une réinstallation poserait un second jeu de
 * hooks à côté. Chaque événement partirait alors en double dans le spool.
 *
 * Reconnu à la désinstallation et au nettoyage, jamais écrit : une installation
 * neuve ne pose que le nom courant.
 */
export const KOH_LEGACY_MARKER = 'koh-claude-bridge';

function isMarker(path: string, marker: string): boolean {
  return path === marker || path.endsWith(`/${marker}`);
}

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
 * bridge (`sh -c 'autre-chose && ~/.koh-vibe/bin/koh-vibe-bridge'`) : elle serait
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
  if (bridgePath === undefined) return false;
  return isMarker(bridgePath, KOH_MARKER) || isMarker(bridgePath, KOH_LEGACY_MARKER);
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

  // Rien à nous ni à personne d'autre : ne pas laisser une clé `hooks: {}`
  // résiduelle dans un fichier qui n'est pas le nôtre.
  if (Object.keys(hooks).length > 0) {
    root['hooks'] = hooks;
  } else {
    delete root['hooks'];
  }
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

/** Marqueur qui rend notre entrée de statusline reconnaissable, comme KOH_MARKER pour les hooks. */
export const KOH_STATUSLINE_MARKER = 'koh-vibe-statusline';

// Le gabarit exact que nous écrivons, et lui seul. Le chemin du pont est capturé
// une fois et retrouvé par rétro-référence : les deux occurrences ne peuvent pas
// diverger. Le second groupe est la commande précédente, encodée en base64 —
// vide si la place était libre.
const OUR_STATUSLINE_RE = new RegExp(
  `^/bin/sh -c '\\[ -x "([^"]+)" \\] && exec "\\1" "([A-Za-z0-9+/=]*)"; exec /bin/sh -c "\\$\\(printf %s "\\2" \\| /usr/bin/base64 -d\\)"'$`,
);

function statusLineCommandOf(settings: unknown): string | undefined {
  if (!isRecord(settings)) return undefined;
  const line = settings['statusLine'];
  if (!isRecord(line)) return undefined;
  const command = line['command'];
  return typeof command === 'string' ? command : undefined;
}

/**
 * Ce que notre entrée de statusline enveloppe : la commande qui occupait la
 * place avant nous, ou `undefined` si l'entrée n'est pas la nôtre.
 *
 * Reconnaissance par gabarit exact, jamais par sous-chaîne — même raison que
 * `isOurs` : une commande étrangère qui MENTIONNERAIT notre pont serait sinon
 * classée comme nôtre, puis supprimée à la désinstallation.
 */
export function wrappedStatusLine(settings: unknown): string | undefined {
  const command = statusLineCommandOf(settings);
  if (command === undefined) return undefined;
  const match = OUR_STATUSLINE_RE.exec(command);
  if (!match) return undefined;
  const bridge = match[1];
  if (bridge === undefined || !(bridge === KOH_STATUSLINE_MARKER || bridge.endsWith(`/${KOH_STATUSLINE_MARKER}`))) {
    return undefined;
  }
  const encoded = match[2] ?? '';
  return encoded.length === 0 ? '' : Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Installe notre pont de statusline en DÉLÉGUANT à ce qui s'y trouvait.
 *
 * Claude Code n'offre qu'un seul emplacement de statusline. Le prendre sans
 * rendre la main couperait l'outil qui l'occupait — Vibe Island y lit ses
 * limites d'usage, et c'est de là que vient la donnée qu'on affiche. La commande
 * précédente est donc encodée en base64 et passée en argument : l'encodage évite
 * tout niveau de citation supplémentaire dans une chaîne qui traverse déjà JSON
 * puis deux shells.
 *
 * La seconde moitié de la commande est un repli : si notre pont a disparu (paquet
 * désinstallé, dossier d'état effacé), la commande précédente s'exécute quand
 * même. Perdre notre mesure est acceptable ; casser en silence la statusline de
 * quelqu'un d'autre ne l'est pas.
 *
 * Réinstaller par-dessus notre propre entrée ne l'imbrique pas : la commande
 * enveloppée est celle qu'on enveloppait déjà.
 */
export function installStatusLine(settings: unknown, bridgePath: string): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  const already = wrappedStatusLine(root);
  const previous = already ?? statusLineCommandOf(root) ?? '';
  const encoded = Buffer.from(previous, 'utf8').toString('base64');
  const command =
    `/bin/sh -c '[ -x "${bridgePath}" ] && exec "${bridgePath}" "${encoded}"; ` +
    `exec /bin/sh -c "$(printf %s "${encoded}" | /usr/bin/base64 -d)"'`;
  root['statusLine'] = { type: 'command', command };
  return root;
}

/**
 * Rend la place à qui l'occupait. Une entrée qui n'est pas la nôtre n'est pas
 * touchée. Si nous n'enveloppions rien, la clé disparaît entièrement plutôt que
 * de laisser une statusline vide derrière nous.
 */
export function uninstallStatusLine(settings: unknown): unknown {
  const root = isRecord(settings) ? { ...settings } : {};
  const previous = wrappedStatusLine(root);
  if (previous === undefined) return root;
  if (previous.length === 0) {
    delete root['statusLine'];
    return root;
  }
  root['statusLine'] = { type: 'command', command: previous };
  return root;
}
