import { HOOK_EVENTS, LOCAL_EVENTS, type EventName, type SpoolEvent } from './types';

const NAMES: readonly string[] = [...HOOK_EVENTS, ...LOCAL_EVENTS];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Réduit toute suite de blancs (espaces, tabulations, retours à la ligne) à
 * un seul espace. Toute valeur destinée à l'affichage passe par ici, à la
 * frontière où elle entre dans le système — jamais chez l'un de ses
 * lecteurs : `currentAction.target` et `pendingPermission.summary`
 * (store/reduce.ts) partagent la même source (`ev.toolTarget`), et
 * `ev.message` alimente aussi ce second champ en repli. Normaliser une fois
 * ici couvre les deux, et tout futur lecteur, sans qu'il ait à y penser.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `str()` puis normalisation des blancs ; vide après normalisation = absent. */
function displayText(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const normalized = normalizeWhitespace(s);
  return normalized.length > 0 ? normalized : undefined;
}

function isEventName(v: string): v is EventName {
  return NAMES.includes(v);
}

// Liste blanche, pas liste noire : les session_id réels observés sont des
// UUID (chiffres hexadécimaux et tirets). N'importe quel autre caractère —
// `/`, `\`, un octet NUL, un espace, un caractère exotique — est refusé par
// construction, sans qu'il faille l'énumérer un par un. Une liste de
// caractères interdits en oublie toujours un (M7 initial ne bloquait que
// `/`, `\`, `.` et `..` : un octet NUL passait).
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * `writeSession`/`readSession` utilisent `session_id` tel quel dans un nom de
 * fichier (`sessions/<id>.json`, `.tmp-<id>-<pid>-<seq>`) : un id inutilisable
 * comme composant de chemin produit un `ENOENT` à l'écriture — une donnée mal
 * formée ne doit jamais faire lever une écriture en aval, elle doit être
 * refusée ici, à la frontière.
 */
function isValidSessionId(id: string): boolean {
  return id !== '.' && id !== '..' && SAFE_SESSION_ID.test(id);
}

/** Première cible lisible d'un appel d'outil, normalisée puis tronquée pour l'affichage. */
function targetOf(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (toolInput === undefined) return undefined;
  for (const key of ['file_path', 'command', 'path', 'pattern', 'url']) {
    const value = displayText(toolInput[key]);
    if (value === undefined) continue;
    return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return undefined;
}

/**
 * Valide un fichier de spool. Retourne `undefined` pour tout ce qui n'est pas
 * exploitable — un payload d'une future version de Claude Code ne doit jamais
 * faire tomber l'extension.
 */
export function parseSpoolFile(raw: string): SpoolEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;

  const event = str(json['event']);
  const at = typeof json['at'] === 'number' && Number.isFinite(json['at']) ? json['at'] : undefined;
  if (event === undefined || at === undefined || !isEventName(event)) return undefined;

  const payload = isRecord(json['payload']) ? json['payload'] : {};
  const sessionId = str(payload['session_id']);
  const cwd = str(payload['cwd']);
  if (sessionId === undefined || cwd === undefined || !isValidSessionId(sessionId)) return undefined;

  const toolInput = isRecord(payload['tool_input']) ? payload['tool_input'] : undefined;

  return {
    event,
    at,
    entrypoint: str(json['entrypoint']) ?? '',
    termProgram: str(json['termProgram']) ?? '',
    sessionId,
    cwd,
    transcriptPath: str(payload['transcript_path']),
    toolName: str(payload['tool_name']),
    toolTarget: targetOf(toolInput),
    message: displayText(payload['message']),
  };
}
