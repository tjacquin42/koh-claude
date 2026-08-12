import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpoolDirs } from '../paths';
import type { Origin, Session, Status } from '../events/types';

// Record<Status, true> et Record<Origin, true> : si l'union gagne un membre côté
// events/types.ts sans que ces tables soient mises à jour, la compilation échoue —
// la garde de type ne peut pas dériver silencieusement du contrat de Session.
const STATUSES: Record<Status, true> = {
  running: true,
  waiting: true,
  done_unseen: true,
  idle: true,
  stale: true,
};
const ORIGINS: Record<Origin, true> = {
  vscode: true,
  terminal: true,
  desktop: true,
  sdk: true,
  unknown: true,
};

export async function ensureDirs(dirs: SpoolDirs): Promise<void> {
  for (const dir of [dirs.events, dirs.sessions, dirs.requests, dirs.rejected, dirs.backups]) {
    await mkdir(dir, { recursive: true });
  }
}

// `process.pid` seul n'est pas unique par appel : cette fonction est exportée
// et réutilisable, rien ne garantit qu'un appelant la sérialise (aujourd'hui
// SpoolWatcher.tick() le fait, mais c'est une propriété de l'appelant, pas de
// la fonction). Même compteur synchrone qu'`appendLocalEvent`.
let writeSessionSeq = 0;

/**
 * Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau,
 * jamais un fichier à moitié écrit.
 */
export async function writeSession(dirs: SpoolDirs, s: Session): Promise<void> {
  const seq = (writeSessionSeq += 1);
  const target = join(dirs.sessions, `${s.id}.json`);
  const tmp = join(dirs.sessions, `.tmp-${s.id}-${process.pid}-${seq}`);
  await writeFile(tmp, JSON.stringify(s), 'utf8');
  await rename(tmp, target);
}

export async function removeSession(dirs: SpoolDirs, id: string): Promise<void> {
  try {
    await unlink(join(dirs.sessions, `${id}.json`));
  } catch {
    // déjà supprimé par une autre fenêtre : bénin
  }
}

function isSession(v: unknown): v is Session {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['cwd'] === 'string' &&
    typeof o['project'] === 'string' &&
    typeof o['origin'] === 'string' &&
    o['origin'] in ORIGINS &&
    typeof o['status'] === 'string' &&
    o['status'] in STATUSES &&
    typeof o['toolCount'] === 'number' &&
    typeof o['lastEventAt'] === 'number'
  );
}

/**
 * Lit une seule session par id, sans lister tout `sessions/`. C'est le
 * chemin de lecture utilisé pour réduire un événement : relire l'état de
 * cette session juste avant de la réduire, plutôt que de le tenir depuis un
 * instantané pris avant une suite d'`await` (voir `drain`).
 */
export async function readSession(dirs: SpoolDirs, id: string): Promise<Session | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dirs.sessions, `${id}.json`), 'utf8'));
    return isSession(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readSessions(dirs: SpoolDirs): Promise<Map<string, Session>> {
  const out = new Map<string, Session>();
  let names: string[];
  try {
    names = await readdir(dirs.sessions);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dirs.sessions, name), 'utf8'));
      if (isSession(parsed)) out.set(parsed.id, parsed);
    } catch {
      // fichier illisible : on l'ignore, il sera réécrit au prochain événement
    }
  }
  return out;
}

/**
 * Purge `sessions/<id>.json` dont `lastEventAt` dépasse `maxAgeMs` (spec §5,
 * ligne 206 : 24 h sans événement). Idempotente et tolérante à la
 * concurrence : `removeSession` avale déjà un fichier absent (une autre
 * fenêtre qui a purgé la même session au même instant n'est pas une erreur —
 * la suppression est le seul acquittement, exactement comme pour un événement
 * consommé). Retourne les ids purgés pour que l'appelant puisse aussi retirer
 * l'entrée correspondante d'un cache en mémoire (ex : la `Map` de transcripts).
 *
 * Même principe qu'I1 dans `drain()` : la liste des ids candidats sert
 * seulement à savoir qui regarder, jamais à décider. Chaque id est relu
 * individuellement (`readSession`) juste avant la suppression, et seul le
 * verdict de cette lecture-là compte — pas un instantané pris avant les
 * `await` de cette boucle. Une session ravivée par une autre fenêtre pendant
 * qu'on en traite une autre survit donc à ce passage : la purge qui se trompe
 * efface, contrairement à `drain()` où une erreur se corrige au tick suivant.
 * Ordre trié pour un comportement déterministe, indépendant de l'ordre de
 * `readdir`.
 */
export async function purgeStaleSessions(dirs: SpoolDirs, now: number, maxAgeMs: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dirs.sessions);
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();

  const purged: string[] = [];
  for (const id of ids) {
    const current = await readSession(dirs, id);
    if (current !== undefined && now - current.lastEventAt > maxAgeMs) {
      await removeSession(dirs, id);
      purged.push(id);
    }
  }
  return purged;
}
