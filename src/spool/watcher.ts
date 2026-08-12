import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpoolDirs } from '../paths';
import { parseSpoolFile } from '../events/parse';
import { reduce } from '../store/reduce';
import { SESSION_PURGE_MS } from '../store/staleness';
import { purgeStaleSessions, readSession, removeSession, writeSession } from './persist';
import { GUARD_TIMEOUT_MS, ReentrantGuard } from '../lib/reentrant-guard';

export interface DrainResult {
  applied: number;
  rejected: number;
  /** Traité mais pas écrit (panne d'E/S externe à l'événement) : laissé en
   * place dans events/ pour un prochain drain, ni perdu ni classé invalide. */
  deferred: number;
  /** Sessions supprimées pour n'avoir reçu aucun événement depuis plus de
   * `SESSION_PURGE_MS` (spec §5). */
  purged: string[];
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Consomme tout le spool une fois, puis purge les sessions mortes depuis plus
 * de `SESSION_PURGE_MS`.
 *
 * L'ordre est essentiel : on écrit l'état AVANT de supprimer l'événement. Une
 * autre fenêtre qui rate l'événement supprimé retrouve l'état dans sessions/ ;
 * l'inverse laisserait un trou.
 *
 * Chaque événement relit l'état de SA session juste avant de la réduire —
 * jamais un instantané de la carte entière tenu au travers de plusieurs
 * `await` : une autre fenêtre peut écrire ou supprimer cette même session
 * entre deux itérations de cette boucle, et il faut toujours réduire contre
 * le plus récent, pas contre ce qui était vrai au tout début de ce drain.
 */
export async function drain(dirs: SpoolDirs, now: number): Promise<DrainResult> {
  let names: string[] = [];
  try {
    names = await readdir(dirs.events);
  } catch {
    names = [];
  }

  // Le nom commence par l'horodatage : le tri lexicographique suit le temps.
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  let applied = 0;
  let rejected = 0;
  let deferred = 0;

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

    try {
      const current = await readSession(dirs, ev.sessionId);
      const next = reduce(current, ev);
      if (next === undefined) {
        await removeSession(dirs, ev.sessionId);
      } else {
        await writeSession(dirs, next);
      }
    } catch {
      // Échec externe à cet événement précis (disque plein, sessions/ non
      // inscriptible, volume en lecture seule) : ni ses effets ni la
      // suppression de son fichier n'ont eu lieu. On le laisse en place pour
      // qu'un prochain drain — dans cette fenêtre ou une autre — le retente,
      // plutôt que de le perdre ou de le classer comme donnée invalide (il ne
      // l'est pas). Sans ce `continue`, l'exception remonterait et
      // arrêterait la boucle : les événements suivants, pourtant sans
      // rapport avec cette panne, resteraient non traités — et comme le tri
      // est chronologique, le premier fichier fautif bloquerait tous les
      // suivants à chaque drain, dans toutes les fenêtres.
      deferred += 1;
      continue;
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

  const purged = await purgeStaleSessions(dirs, now, SESSION_PURGE_MS);

  return { applied, rejected, deferred, purged };
}

export interface LocalEventInput {
  event: 'Ack';
  sessionId: string;
  cwd: string;
}

// `appendLocalEvent` tourne dans le process long de l'extension : contrairement
// au bridge, où un process équivaut à un appel, `process.pid` n'y est pas
// unique par appel. Un compteur incrémenté en synchrone à chaque appel l'est,
// même pour des appels concurrents sans `await` entre eux.
let localEventSeq = 0;

// Un id de process non zero-paddé trie mal lexicographiquement au sein d'une
// même milliseconde (`"9" > "1"`, alors que 9 < 10) : deux événements posés à
// la même milliseconde par des process d'id de largeurs différentes peuvent
// alors s'appliquer dans le mauvais ordre. Un padding fixe, assez large pour
// n'être jamais atteint par un vrai pid, ferme cette ambiguïté pour de bon.
const PID_WIDTH = 10;
function pad(pid: number): string {
  return String(pid).padStart(PID_WIDTH, '0');
}

/** Dépose une action de l'utilisateur dans le même spool que les hooks. */
export async function appendLocalEvent(dirs: SpoolDirs, input: LocalEventInput): Promise<void> {
  const at = Date.now();
  const seq = (localEventSeq += 1);
  const pid = pad(process.pid);
  const body = JSON.stringify({
    event: input.event,
    at,
    entrypoint: 'claude-vscode',
    termProgram: 'vscode',
    payload: { session_id: input.sessionId, cwd: input.cwd },
  });
  const name = `${at}-${pid}-${seq}-${input.event}.json`;
  const tmp = join(dirs.events, `.tmp-${pid}-${seq}-${input.event}`);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, join(dirs.events, name));
}

/** Surveille le spool et appelle `onChange` après chaque vidange utile. */
export class SpoolWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly guard = new ReentrantGuard(GUARD_TIMEOUT_MS);

  constructor(
    private readonly dirs: SpoolDirs,
    private readonly onChange: (result: DrainResult) => void,
    private readonly onError: (err: unknown) => void,
    // Horloge injectable : un test pilote le seuil de purge sans dépendre du
    // vrai Date.now() (qui purgerait aussitôt des sessions de test dont les
    // `at` sont de petits entiers). Le process long de l'extension garde le
    // comportement par défaut.
    private readonly now: () => number = Date.now,
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

  private tick(): Promise<void> {
    return this.guard.run(async () => {
      const res = await drain(this.dirs, this.now());
      if (res.applied > 0 || res.purged.length > 0) this.onChange(res);
    }, this.onError);
  }
}
