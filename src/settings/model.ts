import { clampVolume, DEFAULT_VOLUME, NO_SOUND } from '../sound/player';

/**
 * Les réglages du son, partagés entre TOUS les éditeurs de la machine.
 *
 * Ils vivaient dans les réglages VSCode, donc dans ceux de chaque éditeur pris
 * séparément : la même machine annonçait « Chute 3 » dans une fenêtre et
 * « Funk » dans l'autre, pour le même carillon et le même utilisateur. Le
 * classement en dossiers avait déjà tranché la question — un fichier partagé
 * sous `~/.koh-vibe` — et il n'y avait aucune raison que le son y échappe.
 *
 * Ce qui reste propre à chaque éditeur : rien. Un son est une propriété de la
 * machine (ses haut-parleurs, sa bibliothèque), pas de la fenêtre qui l'a
 * choisi.
 */
export interface AppSettings {
  waiting: string;
  done: string;
  volume: number;
}

export function defaultSettings(): AppSettings {
  return { waiting: NO_SOUND, done: NO_SOUND, volume: DEFAULT_VOLUME };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sound(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Un fichier illisible vaut « réglages par défaut » : le tableau de bord doit
 * s'afficher quoi qu'il arrive, et un carillon muet se rattrape en deux clics.
 *
 * Chaque champ retombe SÉPARÉMENT sur sa valeur par défaut : un volume abîmé ne
 * doit pas emporter avec lui le choix des sons.
 */
export function parseSettings(raw: string): AppSettings {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return defaultSettings();
  }
  if (!isRecord(root)) return defaultSettings();
  const base = defaultSettings();
  return {
    waiting: sound(root['waiting'], base.waiting),
    done: sound(root['done'], base.done),
    // `clampVolume` retombe déjà sur la valeur par défaut plutôt que sur le
    // silence : un réglage abîmé ne doit pas se traduire par « le son ne marche
    // plus », qui enverrait chercher la panne ailleurs.
    volume: clampVolume(root['volume']),
  };
}

export function serializeSettings(s: AppSettings): string {
  return `${JSON.stringify({ version: 1, waiting: s.waiting, done: s.done, volume: clampVolume(s.volume) }, null, 2)}\n`;
}
