import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { groupsFile, kohVibeHome, legacyHome, spoolDirs } from './paths';
import { migrateLegacyHome } from './store/migrate';
import { readUsage, refreshFromApi } from './usage/reader';
import { chimeFor, statusesOf, type ChimeEvent } from './sound/model';
import { availableSounds, clampVolume, DEFAULT_VOLUME, NO_SOUND, playFile, playNamed } from './sound/player';
import { FooterTree, type SoundSettings } from './ui/footer-tree';
import { ensureDirs, readSessions } from './spool/persist';
import { SpoolWatcher } from './spool/watcher';
import { pruneAssignmentsAfterPurge } from './groups/purge';
import { applyDrop, colorGroupCommand, createGroupCommand, deleteGroupCommand, renameGroupCommand, runGroupAction } from './groups/commands';
import { colorChoice, GROUP_COLORS, NO_COLOR_LABEL } from './ui/colors';
import { readGroups } from './groups/store';
import type { TranscriptStats } from './transcript/reader';
import { withTokens } from './transcript/tokens';
import { SessionsTree, groupIdOfNode } from './ui/tree';
import { decorationColorOf } from './ui/decorations';
import { StatusSummary } from './ui/statusbar';
import { readBuildStamp, versionLabel } from './ui/version';
import { FocusBroker } from './focus/broker';
import { acknowledgeClickedSession, acknowledgeVisibleSessions } from './focus/acknowledge';
import { countKohEntries } from './hooks/installer';
import type { Session } from './events/types';
import { GUARD_TIMEOUT_MS, ReentrantGuard } from './lib/reentrant-guard';

const REFRESH_MS = 2_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const home = kohVibeHome();
  // Avant tout le reste : ensureDirs créerait la nouvelle racine et rendrait la
  // reprise impossible — elle ne s'opère que si cette racine n'existe pas encore.
  const migrated = await migrateLegacyHome(legacyHome(), home);
  const dirs = spoolDirs(home);
  const groupsPath = groupsFile(home);
  await ensureDirs(dirs);
  if (migrated === 'migrated') {
    void vscode.window.showInformationMessage(
      "Koh-Vibe : l'extension a changé de nom. Vos dossiers et vos sessions ont été repris ; " +
        'relancez « Installer les hooks » pour que Claude Code pointe vers le nouveau pont.',
    );
  }

  // Relu à chaque fois que l'arbre s'apprête à afficher son nœud vide (voir
  // SessionsTree), jamais mis en cache ici : le coût (une lecture de fichier)
  // n'est payé que dans le cas rare où il n'y a aucune session à montrer.
  async function checkHooksInstalled(): Promise<boolean> {
    try {
      const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8');
      return countKohEntries(JSON.parse(raw)) > 0;
    } catch {
      return false;
    }
  }

  // Le vrai câblage du glisser-déposer : appelle updateGroups au travers
  // d'applyDrop (groups/commands.ts), jamais une écriture directe — voir sa
  // documentation. Un rendu explicite suit l'écriture pour que le dossier se
  // peuple tout de suite à l'écran, sans attendre le minuteur (REFRESH_MS).
  async function onSessionsDropped(
    sessionIds: readonly string[],
    groupId: string | undefined,
    order: readonly string[],
  ): Promise<void> {
    await applyDrop(groupsPath, sessionIds, groupId, order);
    await render();
  }

  /**
   * Les réglages du son, relus à chaque usage plutôt que captés au démarrage :
   * ils vivent dans les réglages VSCode, donc modifiables depuis l'interface
   * des réglages autant que depuis nos lignes.
   */
  function soundSettings(): SoundSettings {
    const config = vscode.workspace.getConfiguration('kohVibe');
    const name = (key: string): string => {
      const value = config.get(key);
      return typeof value === 'string' ? value : NO_SOUND;
    };
    return {
      waiting: name('sound.waiting'),
      done: name('sound.done'),
      volume: clampVolume(config.get('sound.volume')),
    };
  }

  // Référence du tour précédent pour le carillon. `undefined` = premier rendu :
  // tout y ressemblerait à une transition, et l'éditeur carillonnerait à chaque
  // ouverture de fenêtre pour des sessions parfois vieilles de plusieurs heures.
  let lastStatuses: Map<string, Session['status']> | undefined;

  const tree = new SessionsTree(checkHooksInstalled, onSessionsDropped);
  const footer = new FooterTree();
  const status = new StatusSummary();
  const broker = new FocusBroker(dirs);
  const transcripts = new Map<string, TranscriptStats>();

  // Seul moyen offert par VSCode de colorer le TEXTE d'une ligne d'arbre. Sans
  // état propre : la couleur est portée par l'URI que l'arbre pose sur chaque
  // ligne, donc rien à resynchroniser quand elle change.
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        const color = decorationColorOf(uri);
        return color === undefined ? undefined : { color: new vscode.ThemeColor(color) };
      },
    }),
  );

  const view = vscode.window.createTreeView('kohVibe.sessions', {
    treeDataProvider: tree,
    dragAndDropController: tree,
  });
  // Vue distincte, sous la première dans le même conteneur : VSCode n'offre
  // aucun moyen d'épingler une ligne au bas d'un arbre, et tout ce qu'on y
  // mettait défilait avec les conversations.
  context.subscriptions.push(
    footer,
    vscode.window.createTreeView('kohVibe.settings', { treeDataProvider: footer }),
  );

  // Posée une fois : ni la version ni le commit ne changent tant que la fenêtre
  // vit — un paquet réinstallé n'est vu qu'au rechargement, et c'est justement
  // ce que cette ligne sert à constater.
  view.description = versionLabel(await readBuildStamp(context.extensionPath));

  // Un seul avertissement par cause, jamais un par tick (le minuteur tourne
  // toutes les REFRESH_MS) : même précédent que `warnedMissingCommand` dans
  // FocusBroker.
  let transcriptFailureWarned = false;
  let renderFailureWarned = false;
  let drainFailureWarned = false;
  // Garde de réentrance factorisée (ReentrantGuard) : render() est déclenché
  // par trois sources indépendantes (minuteur, watcher, commande de
  // rafraîchissement), qui peuvent se chevaucher si un rendu est lent — même
  // motif que SpoolWatcher.tick() et FocusBroker.tick().
  const renderGuard = new ReentrantGuard(GUARD_TIMEOUT_MS);

  async function render(): Promise<void> {
    return renderGuard.run(
      async () => {
        // Lu à chaque rendu, comme l'état des sessions : un seul petit fichier,
        // et le pont le réécrit à chaque message de Claude Code. Le mettre en
        // cache ferait afficher un pourcentage périmé — le défaut qu'on a déjà
        // payé trois fois dans ce projet.
        // Interroge l'API au plus toutes les REFRESH_AFTER_MS, quel que soit le
        // nombre de fenêtres : le relevé est mis en cache dans un fichier
        // partagé, et ce rendu-ci ne fait que lire le plus frais des deux.
        void refreshFromApi(home, false);
        footer.setUsage(await readUsage(home));
        footer.setSound(soundSettings());
        const map = await withTokens(await readSessions(dirs), transcripts, () => {
          if (transcriptFailureWarned) return;
          transcriptFailureWarned = true;
          void vscode.window.showWarningMessage(
            "Koh-Vibe : lecture d'un transcript impossible — cette session s'affiche sans ses compteurs.",
          );
        });
        // Relu à chaque rendu, jamais mis en cache : fichier partagé (§3),
        // une autre fenêtre ou un autre éditeur peut l'avoir changé entre deux
        // tours. `readGroups` n'échoue jamais (un fichier absent ou illisible
        // vaut « classement vide », voir groups/store.ts) : aucune garde de
        // type `*FailureWarned` n'est nécessaire ici.
        const groups = await readGroups(groupsPath);
        // Le carillon avant l'affichage : `shouldChime` compare l'état du tour
        // précédent au nouveau, et `lastStatuses` doit avancer à CHAQUE rendu,
        // même silencieux — sinon la comparaison se ferait contre un état de
        // plus en plus ancien, et une bascule finirait par sonner deux fois.
        const statuses = statusesOf(map);
        const event = chimeFor(lastStatuses, statuses);
        if (event !== undefined) {
          const sound = soundSettings();
          void playNamed(event === 'waiting' ? sound.waiting : sound.done, sound.volume);
        }
        lastStatuses = statuses;
        tree.setSessions(map);
        tree.setGroups(groups);
        status.update(map);
      },
      () => {
        // Filet générique : quelle que soit la cause restée hors de l'isolation
        // par session ci-dessus, ce rendu échoue seul — jamais les suivants. Le
        // minuteur, le watcher et la commande de rafraîchissement redéclenchent
        // tous render() indépendamment de cet échec.
        if (renderFailureWarned) return;
        renderFailureWarned = true;
        void vscode.window.showWarningMessage(
          'Koh-Vibe : le rendu du tableau de bord a échoué — nouvelle tentative automatique.',
        );
      },
    );
  }

  const watcher = new SpoolWatcher(
    dirs,
    (res) => {
      // Une session purgée (24h sans événement, voir purgeStaleSessions) ne
      // doit pas laisser une entrée orpheline dans ce cache en mémoire :
      // sinon la purge sur disque ne borne rien côté mémoire.
      for (const id of res.purged) transcripts.delete(id);
      // Même principe côté classement en dossiers : l'affectation d'une
      // session purgée est un déchet sans nettoyage. pruneAssignmentsAfterPurge
      // n'écrit rien quand res.purged est vide (la quasi-totalité des tours).
      void pruneAssignmentsAfterPurge(dirs, groupsPath, res.purged).catch(() => undefined);
      void render();
    },
    () => {
      if (drainFailureWarned) return;
      drainFailureWarned = true;
      void vscode.window.showWarningMessage(
        'Koh-Vibe : la lecture des événements a échoué — nouvelle tentative automatique.',
      );
    },
  );
  watcher.start();
  broker.start();

  function workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  // Acquitte les sessions terminées quand la vue devient visible dans cette
  // fenêtre — mais seulement celles que cette fenêtre revendique (spec §5).
  // acknowledgeVisibleSessions est testée directement (test/acknowledge.test.ts) :
  // le point d'appel lui-même, pas seulement la primitive pure qu'il utilise.
  const onVisible = view.onDidChangeVisibility(async (e) => {
    if (!e.visible) return;
    await acknowledgeVisibleSessions(dirs, workspaceFolders());
  });

  const ticker = setInterval(() => void render(), REFRESH_MS);

  // Chemin absolu : le terminal lancé par les deux commandes ci-dessous peut
  // avoir n'importe quel répertoire courant, le script n'en dépend pas.
  const installScript = join(context.extensionPath, 'scripts', 'install-hooks.cjs');

  context.subscriptions.push(
    view,
    tree,
    onVisible,
    status,
    { dispose: () => watcher.stop() },
    { dispose: () => broker.stop() },
    { dispose: () => clearInterval(ticker) },
    vscode.commands.registerCommand('kohVibe.refresh', () => void render()),
    vscode.commands.registerCommand('kohVibe.focusSession', (s: Session) => {
      // Le clic acquitte inconditionnellement (spec §5 : « clic sur la
      // session »), indépendamment de claims() — qui ne gouverne que
      // l'acquittement passif d'acknowledgeVisibleSessions, ci-dessus.
      // acknowledgeClickedSession est testée directement, comme sa jumelle.
      void acknowledgeClickedSession(dirs, s).catch(() => undefined);
      void broker.request(s).catch(() => undefined);
    }),
    vscode.commands.registerCommand('kohVibe.installHooks', () => {
      const terminal = vscode.window.createTerminal('Koh-Vibe');
      terminal.sendText(`node "${installScript}"`);
      terminal.show();
    }),
    vscode.commands.registerCommand('kohVibe.uninstallHooks', () => {
      const terminal = vscode.window.createTerminal('Koh-Vibe');
      terminal.sendText(`node "${installScript}" --uninstall`);
      terminal.show();
    }),
    // Les trois commandes de dossier partagent le même filet : runGroupAction
    // (groups/commands.ts) transforme tout ce que la décision lève — en
    // particulier le nom vide, que createGroup/renameGroup rejettent
    // volontairement — en message affiché, jamais en trace d'appel non gérée.
    vscode.commands.registerCommand('kohVibe.newGroup', async () => {
      const label = await vscode.window.showInputBox({ prompt: 'Nom du dossier', placeHolder: 'Perso' });
      await runGroupAction(
        () => createGroupCommand(groupsPath, label, () => randomUUID()),
        (message) => void vscode.window.showErrorMessage(message),
      );
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.renameGroup', async (node: unknown) => {
      const id = groupIdOfNode(node);
      if (id === undefined) return;
      const label = await vscode.window.showInputBox({ prompt: 'Nouveau nom du dossier' });
      await runGroupAction(
        () => renameGroupCommand(groupsPath, id, label),
        (message) => void vscode.window.showErrorMessage(message),
      );
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.refreshUsage', async () => {
      // `force` : sans lui ce bouton attendrait l'échéance comme un rendu
      // ordinaire, et ne rafraîchirait rien.
      const reading = await refreshFromApi(home, true);
      await render();
      if (reading === undefined) {
        void vscode.window.showInformationMessage(
          'Koh-Vibe : consommation indisponible — Anthropic injoignable, ou accès au trousseau refusé.',
        );
      }
    }),
    vscode.commands.registerCommand('kohVibe.chooseSound', async (event: unknown) => {
      const which: ChimeEvent = event === 'done' ? 'done' : 'waiting';
      const sounds = await availableSounds();
      if (sounds.length === 0) {
        void vscode.window.showInformationMessage('Koh-Vibe : aucun son trouvé sur cette machine.');
        return;
      }
      const settings = soundSettings();
      // `createQuickPick` et non `showQuickPick` : lui seul expose
      // `onDidChangeActive`, donc le survol au clavier. Choisir un son sans
      // l'entendre oblige à attendre une vraie bascule pour savoir ce qu'on a pris.
      const picker = vscode.window.createQuickPick();
      picker.title = which === 'waiting' ? "Son quand une session t'attend" : 'Son quand une session a fini';
      picker.placeholder = 'Les flèches font entendre chaque son';
      picker.items = [
        { label: 'Aucun', description: 'aucun son pour cet événement' },
        ...sounds.map((s) => ({ label: s.name, description: s.path })),
      ];
      picker.onDidChangeActive((active) => {
        const item = active[0];
        if (item === undefined || item.label === 'Aucun') return;
        void playNamed(item.label, settings.volume);
      });
      const chosen = await new Promise<string | undefined>((resolve) => {
        picker.onDidAccept(() => resolve(picker.selectedItems[0]?.label));
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
      picker.dispose();
      if (chosen === undefined) return;
      await vscode.workspace
        .getConfiguration('kohVibe')
        .update(`sound.${which}`, chosen === 'Aucun' ? NO_SOUND : chosen, vscode.ConfigurationTarget.Global);
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.chooseVolume', async () => {
      const settings = soundSettings();
      const steps = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const sounds = await availableSounds();
      // Le son d'essai est celui déjà choisi ; à défaut, le premier venu — sans
      // quoi régler le volume avant d'avoir choisi un son se ferait en silence.
      const sample = sounds.find((s) => s.name === settings.waiting) ?? sounds[0];
      const picker = vscode.window.createQuickPick();
      picker.title = 'Volume des carillons';
      picker.placeholder = 'Les flèches font entendre chaque niveau';
      picker.items = steps.map((p) => ({ label: `${p} %` }));
      picker.onDidChangeActive((active) => {
        const item = active[0];
        if (item === undefined || sample === undefined) return;
        playFile(sample.path, Number.parseInt(item.label, 10) / 100);
      });
      const chosen = await new Promise<string | undefined>((resolve) => {
        picker.onDidAccept(() => resolve(picker.selectedItems[0]?.label));
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
      picker.dispose();
      if (chosen === undefined) return;
      await vscode.workspace
        .getConfiguration('kohVibe')
        .update('sound.volume', Number.parseInt(chosen, 10) / 100, vscode.ConfigurationTarget.Global);
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.colorGroup', async (node: unknown) => {
      const id = groupIdOfNode(node);
      if (id === undefined) return;
      const pick = await vscode.window.showQuickPick(
        [NO_COLOR_LABEL, ...GROUP_COLORS.map((c) => c.label)],
        { placeHolder: 'Couleur du dossier' },
      );
      // Fermer la liste n'efface rien : la distinction vit dans colorChoice.
      const choice = colorChoice(pick);
      if (choice.kind === 'cancel') return;
      await runGroupAction(
        () => colorGroupCommand(groupsPath, id, choice.color),
        (message) => void vscode.window.showErrorMessage(message),
      );
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.deleteGroup', async (node: unknown) => {
      const id = groupIdOfNode(node);
      if (id === undefined) return;
      await runGroupAction(
        () => deleteGroupCommand(groupsPath, id),
        (message) => void vscode.window.showErrorMessage(message),
      );
      await render();
    }),
  );

  await render();
}

export function deactivate(): void {
  // Toutes les ressources sont enregistrées dans context.subscriptions.
}
