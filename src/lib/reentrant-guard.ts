/**
 * Garde de réentrance : `run()` n'exécute `fn` que si aucun appel précédent
 * n'est encore en vol, et convertit toute erreur en appel à `onError` plutôt
 * que de la laisser remonter en rejet non géré.
 *
 * Ce motif (check / set / try / catch / finally) protégeait `SpoolWatcher.tick`,
 * `FocusBroker.tick` et `render` en trois copies identiques : une correction
 * apportée à l'une (ex : ajouter le `catch`) pouvait être oubliée dans les
 * deux autres. Ne dépend pas de `vscode`, donc testable seul.
 */
export class ReentrantGuard {
  running = false;

  async run(fn: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      this.running = false;
    }
  }
}
