import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpoolDirs } from '../paths';
import { parseSpoolFile } from '../events/parse';
import { reduce } from '../store/reduce';
import { SESSION_PURGE_MS } from '../store/staleness';
import { purgeStaleSessions, readSession, removeSession, writeSession } from './persist';
import { type AbandonSignal, GUARD_TIMEOUT_MS, ReentrantGuard } from '../lib/reentrant-guard';

export interface DrainResult {
  applied: number;
  rejected: number;
  /** Traité mais pas écrit (panne d'E/S externe à l'événement) : laissé en
   * place dans events/ pour un prochain drain, ni perdu ni classé invalide —
   * sauf s'il a dépassé MAX_EVENT_AGE_MS, voir `rejectedPermanently`. */
  deferred: number;
  /** Sessions supprimées pour n'avoir reçu aucun événement depuis plus de
   * `SESSION_PURGE_MS` (spec §5). */
  purged: string[];
  /** Noms des événements écartés vers rejected/ pour avoir échoué alors
   * qu'ils avaient déjà dépassé MAX_EVENT_AGE_MS (N3) : sous-ensemble de ce
   * qui compte dans `rejected`, distingué pour que l'appelant puisse
   * signaler l'abandon plutôt que de le laisser invisible. */
  rejectedPermanently: string[];
}

/**
 * Au-delà de cet âge, un événement qui échoue encore n'est plus considéré
 * transitoire : il est déplacé vers rejected/ avec sa raison plutôt que
 * retenté indéfiniment en silence (N3). L'âge se lit dans le nom de fichier
 * de l'événement lui-même (l'horodatage qui l'ouvre, déjà utilisé pour
 * l'ordre de traitement) — pas dans un compteur de tentatives tenu en
 * mémoire : ce dernier confondait « échoue depuis 2 ms, 3 fois de suite »
 * (sous une rafale de centaines d'événements, un compteur épuise ses
 * tentatives en quelques millisecondes réelles) avec « échoue depuis
 * longtemps », dépendait d'un état par fenêtre (jamais partagé, remis à zéro
 * à chaque réouverture), et donnait un résultat différent selon la fenêtre
 * qui comptait. Une durée n'a aucun de ces défauts : la même pour toutes les
 * fenêtres, indépendante de la charge, indifférente à la fermeture d'une
 * fenêtre.
 *
 * 5 minutes : très généreux comparé au temps d'un tick, même chargé (~30 s
 * au pire pour ~660 événements, voir GUARD_TIMEOUT_MS) — un événement qui
 * échoue encore après 5 minutes a déjà survécu à des dizaines de passages,
 * pas juste à un pic de charge. Et très en-dessous de l'échelle « oublié
 * pendant des heures » : rien à voir avec SESSION_PURGE_MS (24 h), qui
 * concerne l'absence totale d'événement, pas un échec actif et répété.
 */
export const MAX_EVENT_AGE_MS = 5 * 60_000;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * L'horodatage qui ouvre le nom de fichier d'un événement (bridge :
 * `<at>-<pid>-<event>.json` ; appendLocalEvent : `<at>-<pid>-<seq>-<event>.json`),
 * en millisecondes epoch. `undefined` pour un nom qui ne commence pas par un
 * nombre — ne devrait pas arriver pour un fichier réellement déposé par ce
 * projet, mais ne pas pouvoir dater un événement ne doit jamais se traduire
 * par « donc il est vieux » : voir l'appelant.
 */
function eventTimestamp(name: string): number | undefined {
  const stamp = name.split('-', 1)[0];
  const at = stamp === undefined || stamp.length === 0 ? NaN : Number(stamp);
  return Number.isFinite(at) ? at : undefined;
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
 *
 * `signal` (fourni par `ReentrantGuard.run()`, absent si on appelle `drain`
 * hors d'une garde) protège contre un défaut qu'I1 ne couvre pas : I1 relit
 * l'état d'une session juste avant de la RÉDUIRE, ce qui protège la lecture,
 * pas l'écriture qui suit. Une exécution abandonnée par la garde (elle a
 * dépassé son délai, mais continue en arrière-plan) peut avoir réduit un
 * état à partir d'une lecture désormais périmée ; si elle écrit quand même,
 * elle écrase un état plus récent écrit entre-temps par un passage frais.
 * `signal.abandoned` est donc consulté juste avant CHAQUE couple
 * écriture-puis-suppression, jamais avant : l'invariant « on écrit l'état
 * avant de supprimer l'événement » est ce qui rend cet abandon sans perte —
 * l'événement, ni appliqué ni supprimé, sera retraité par le passage frais.
 */
export async function drain(dirs: SpoolDirs, now: number, signal?: AbandonSignal): Promise<DrainResult> {
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
  const rejectedPermanently: string[] = [];

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

      if (signal?.abandoned) {
        // Cette exécution a été abandonnée (délai de garde dépassé) pendant
        // qu'elle tenait encore cette lecture périmée : écrire `next`
        // maintenant écraserait un état plus récent écrit par le passage
        // frais qui tourne déjà. On s'arrête ici, avant d'écrire quoi que ce
        // soit — l'événement reste en place, ni appliqué ni supprimé, et
        // sera retraité. Rien d'autre ne peut plus être fait de sûr par
        // cette exécution : on arrête tout le drain, pas seulement cet
        // événement.
        return { applied, rejected, deferred, purged: [], rejectedPermanently };
      }

      if (next === undefined) {
        await removeSession(dirs, ev.sessionId);
      } else {
        await writeSession(dirs, next);
      }
    } catch (err) {
      // Échec externe à cet événement précis (disque plein, sessions/ non
      // inscriptible, volume en lecture seule). Sans ce `continue`,
      // l'exception remonterait et arrêterait la boucle : les événements
      // suivants, pourtant sans rapport avec cette panne, resteraient non
      // traités — et comme le tri est chronologique, le premier fichier
      // fautif bloquerait tous les suivants à chaque drain, dans toutes les
      // fenêtres.
      const createdAt = eventTimestamp(name);
      const age = createdAt !== undefined ? now - createdAt : undefined;
      if (age !== undefined && age > MAX_EVENT_AGE_MS) {
        // Échoue encore alors qu'il est déjà plus vieux que ce qu'un échec
        // transitoire justifie : on cesse de le retenter indéfiniment en
        // silence, et on l'écarte — visible, avec sa raison — plutôt que de
        // le perdre.
        rejected += 1;
        rejectedPermanently.push(name);
        const reason = `Échec à ${age} ms d'âge (> ${MAX_EVENT_AGE_MS} ms) : ${err instanceof Error ? err.message : String(err)}`;
        await writeFile(join(dirs.rejected, `${name}.reason.txt`), reason, 'utf8').catch(() => undefined);
        await rename(path, join(dirs.rejected, name)).catch(() => undefined);
      } else {
        // Ni ses effets ni la suppression de son fichier n'ont eu lieu. On
        // le laisse en place pour qu'un prochain drain — dans cette fenêtre
        // ou une autre — le retente, plutôt que de le perdre ou de le
        // classer comme donnée invalide (il ne l'est pas encore).
        deferred += 1;
      }
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

  return { applied, rejected, deferred, purged, rejectedPermanently };
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
    return this.guard.run(async (signal) => {
      const res = await drain(this.dirs, this.now(), signal);
      if (res.rejectedPermanently.length > 0) {
        // Signalement dédié : drain() n'a pas échoué (les autres événements
        // se sont appliqués normalement), mais celui-ci a échoué alors qu'il
        // était déjà trop vieux pour que ce soit encore transitoire — ça ne
        // doit pas disparaître en silence.
        this.onError(
          new Error(
            `${res.rejectedPermanently.length} événement(s) écarté(s) définitivement (échec persistant au-delà de ${MAX_EVENT_AGE_MS} ms)`,
          ),
        );
      }
      if (res.applied > 0 || res.purged.length > 0) this.onChange(res);
    }, this.onError);
  }
}
