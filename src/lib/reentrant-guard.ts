/**
 * Délai au-delà duquel une exécution gardée est considérée bloquée plutôt
 * que simplement chargée. Calibré sur le pire cas plausible observé en usage
 * réel : un `SpoolWatcher.tick()` avec ~660 événements en attente. Chaque
 * événement coûte au plus quelques dizaines de ms même sur un disque lent
 * (lecture de l'événement, lecture puis écriture ou suppression de la
 * session, suppression de l'événement) — de l'ordre de 30 s au pire pour
 * 660 événements. 60 s laisse une bonne marge au-dessus de cette estimation,
 * tout en restant sans commune mesure avec les 38 minutes de gel observées :
 * un tick qui dépasse ce délai n'est pas juste chargé, il est bloqué.
 *
 * Réutilisé tel quel pour `FocusBroker.tick()` et `render()` : leurs charges
 * de travail respectives (requêtes de focus en attente, sessions affichées)
 * sont sans commune mesure avec 660 événements, donc ce seuil y est très
 * généreux — mais rien ne justifierait un seuil différent, non testé, pour
 * chacune ; un gel y serait de toute façon rattrapé bien avant 60 s dans les
 * cas réels, et la même constante partout évite d'inventer deux nombres sans
 * preuve à l'appui.
 */
export const GUARD_TIMEOUT_MS = 60_000;

/**
 * Garde de réentrance : `run()` n'exécute `fn` que si aucun appel précédent
 * n'est encore en vol, et convertit toute erreur en appel à `onError` plutôt
 * que de la laisser remonter en rejet non géré.
 *
 * Ce motif (check / set / try / catch / finally) protégeait `SpoolWatcher.tick`,
 * `FocusBroker.tick` et `render` en trois copies identiques : une correction
 * apportée à l'une (ex : ajouter le `catch`) pouvait être oubliée dans les
 * deux autres. Ne dépend pas de `vscode`, donc testable seul.
 *
 * `timeoutMs` protège contre l'autre panne, distincte du rejet : `fn` qui ne
 * se règle jamais (ni résolution ni rejet). Sans borne, `running` reste levé
 * pour toujours et tous les appels suivants deviennent des no-op silencieux —
 * un gel total et muet. Passé ce délai, la garde relâche `running` et signale
 * une fois ; `fn` continue en arrière-plan (rien ne peut l'annuler), et si
 * elle finit par rejeter, `onError` la rattrape quand même — abandonner
 * l'attente ne doit pas ouvrir un rejet non géré.
 *
 * Un appel qui arrive après ce relâchement s'exécute concurremment à
 * l'exécution abandonnée : accepté, mais ce n'est PAS sans risque nouveau,
 * contrairement à ce qu'une version antérieure de ce commentaire affirmait.
 * I1 (dans `drain()`) sécurise la *lecture* — relire l'état d'une session
 * juste avant de la réduire — pas l'*écriture* : rien n'empêchait une
 * exécution abandonnée d'écrire, après coup, un état plus ancien par-dessus
 * celui qu'un passage plus récent venait d'écrire. C'est pour ça que `fn`
 * reçoit un `AbandonSignal` : la fonction gardée doit le consulter juste
 * avant d'écrire quoi que ce soit de persistant, et renoncer si `abandoned`
 * est déjà vrai à ce moment-là (voir `drain()`, qui l'utilise juste avant le
 * couple écriture-puis-suppression).
 */
export interface AbandonSignal {
  readonly abandoned: boolean;
}

export class ReentrantGuard {
  running = false;

  constructor(private readonly timeoutMs: number) {}

  async run(fn: (signal: AbandonSignal) => Promise<void>, onError: (err: unknown) => void): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Objet mutable ici ; exposé à `fn` via le type `AbandonSignal` (lecture
    // seule) — la même référence, deux vues. `run()` la flippe au timeout,
    // `fn` ne peut que la lire.
    const signal: { abandoned: boolean } = { abandoned: false };
    const execution = fn(signal);
    // Toujours observée, que le délai soit dépassé ou non : sans ça, une
    // exécution abandonnée par le délai qui finit par rejeter produirait un
    // rejet non géré, exactement ce que ce même mécanisme empêche par
    // ailleurs.
    const settled = execution.then(
      (): { failed: false } => ({ failed: false }),
      (err: unknown): { failed: true; err: unknown } => ({ failed: true, err }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), this.timeoutMs);
    });

    const result = await Promise.race([settled, timedOut]);

    if (result === 'timed-out') {
      this.running = false;
      signal.abandoned = true;
      onError(new Error(`ReentrantGuard : délai de ${this.timeoutMs} ms dépassé sans résolution`));
      void settled.then((late) => {
        if (late.failed) onError(late.err);
      });
      return;
    }

    if (timer !== undefined) clearTimeout(timer);
    this.running = false;
    if (result.failed) onError(result.err);
  }
}
