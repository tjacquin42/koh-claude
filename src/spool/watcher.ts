import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpoolDirs } from '../paths';
import { parseSpoolFile } from '../events/parse';
import type { EventName } from '../events/types';
import { reduce } from '../store/reduce';
import { readSessions, removeSession, writeSession } from './persist';

export interface DrainResult {
  applied: number;
  rejected: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Consomme tout le spool une fois.
 *
 * L'ordre est essentiel : on écrit l'état AVANT de supprimer l'événement. Une
 * autre fenêtre qui rate l'événement supprimé retrouve l'état dans sessions/ ;
 * l'inverse laisserait un trou.
 */
export async function drain(dirs: SpoolDirs): Promise<DrainResult> {
  let names: string[];
  try {
    names = await readdir(dirs.events);
  } catch {
    return { applied: 0, rejected: 0 };
  }

  // Le nom commence par l'horodatage : le tri lexicographique suit le temps.
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  const sessions = await readSessions(dirs);
  let applied = 0;
  let rejected = 0;

  for (const name of files) {
    const path = join(dirs.events, name);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue; // consommé par une autre fenêtre entre le readdir et le readFile
    }

    const ev = parseSpoolFile(raw);
    if (ev === undefined) {
      rejected += 1;
      await rename(path, join(dirs.rejected, name)).catch(() => undefined);
      continue;
    }

    const next = reduce(sessions.get(ev.sessionId), ev);
    if (next === undefined) {
      sessions.delete(ev.sessionId);
      await removeSession(dirs, ev.sessionId);
    } else {
      sessions.set(ev.sessionId, next);
      await writeSession(dirs, next);
    }
    applied += 1;
    try {
      await unlink(path);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // déjà supprimé par une autre fenêtre : bénin, l'état est déjà écrit
      } else {
        // panne réelle (permission, disque plein…) : laisser le fichier en
        // place le ferait réappliquer au prochain drain, et pour un effet
        // cumulatif comme PostToolUse ça corromprait l'état. On l'écarte
        // plutôt, comme un fichier illisible.
        rejected += 1;
        await rename(path, join(dirs.rejected, name)).catch(() => undefined);
      }
    }
  }

  return { applied, rejected };
}

export interface LocalEventInput {
  event: Extract<EventName, 'Ack' | 'Focus'>;
  sessionId: string;
  cwd: string;
}

// `appendLocalEvent` tourne dans le process long de l'extension : contrairement
// au bridge, où un process équivaut à un appel, `process.pid` n'y est pas
// unique par appel. Un compteur incrémenté en synchrone à chaque appel l'est,
// même pour des appels concurrents sans `await` entre eux.
let localEventSeq = 0;

/** Dépose une action de l'utilisateur dans le même spool que les hooks. */
export async function appendLocalEvent(dirs: SpoolDirs, input: LocalEventInput): Promise<void> {
  const at = Date.now();
  const seq = (localEventSeq += 1);
  const body = JSON.stringify({
    event: input.event,
    at,
    entrypoint: 'claude-vscode',
    termProgram: 'vscode',
    payload: { session_id: input.sessionId, cwd: input.cwd },
  });
  const name = `${at}-${process.pid}-${seq}-${input.event}.json`;
  const tmp = join(dirs.events, `.tmp-${process.pid}-${seq}-${input.event}`);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, join(dirs.events, name));
}

/** Surveille le spool et appelle `onChange` après chaque vidange utile. */
export class SpoolWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly dirs: SpoolDirs,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    void this.tick();
    try {
      this.watcher = watch(this.dirs.events, () => this.schedule());
    } catch {
      // Le dossier n'existe pas encore (ex : première ouverture avant tout
      // hook). drain() tolère déjà son absence ; le filet de 5s ci-dessous
      // suffit à prendre le relais dès qu'il apparaîtra.
      this.watcher = undefined;
    }
    // Filet : fs.watch peut manquer des événements sur certains volumes.
    this.timer = setInterval(() => this.schedule(), 5_000);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return; // pas de vidange concurrente dans la même fenêtre
    this.running = true;
    try {
      const res = await drain(this.dirs);
      if (res.applied > 0) this.onChange();
    } finally {
      this.running = false;
    }
  }
}
