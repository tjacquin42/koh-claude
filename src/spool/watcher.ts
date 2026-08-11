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
    await unlink(path).catch(() => undefined);
  }

  return { applied, rejected };
}

export interface LocalEventInput {
  event: Extract<EventName, 'Ack' | 'Focus'>;
  sessionId: string;
  cwd: string;
}

/** Dépose une action de l'utilisateur dans le même spool que les hooks. */
export async function appendLocalEvent(dirs: SpoolDirs, input: LocalEventInput): Promise<void> {
  const at = Date.now();
  const body = JSON.stringify({
    event: input.event,
    at,
    entrypoint: 'claude-vscode',
    termProgram: 'vscode',
    payload: { session_id: input.sessionId, cwd: input.cwd },
  });
  const name = `${at}-${process.pid}-${input.event}.json`;
  const tmp = join(dirs.events, `.tmp-${process.pid}-${input.event}`);
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
    this.watcher = watch(this.dirs.events, () => this.schedule());
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
