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

/**
 * Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau,
 * jamais un fichier à moitié écrit.
 */
export async function writeSession(dirs: SpoolDirs, s: Session): Promise<void> {
  const target = join(dirs.sessions, `${s.id}.json`);
  const tmp = join(dirs.sessions, `.tmp-${s.id}-${process.pid}`);
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
