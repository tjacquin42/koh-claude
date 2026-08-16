import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { closedFile, groupsFile, kohVibeHome, legacyHome, settingsFile, spoolDirs } from './paths';
import { rememberClosed } from './closed/store';
import { toClosedEntry } from './closed/model';
import { readSettings, seedSettings, writeSettings } from './settings/store';
import { defaultSettings, type AppSettings } from './settings/model';
import { migrateLegacyHome } from './store/migrate';
import { readUsage, refreshFromApi } from './usage/reader';
import { chimeFor, statusesOf, type ChimeEvent } from './sound/model';
import { availableSounds, clampVolume, NO_SOUND, playFile, playNamed } from './sound/player';
import { EVENT_TITLE, FooterTree, type SoundSettings } from './ui/footer-tree';
import { UsageView } from './ui/usage-view';
import { ensureDirs, readSessions, removeSession } from './spool/persist';
import { SpoolWatcher } from './spool/watcher';
import { pruneAssignmentsAfterPurge } from './groups/purge';
import {
  applyDrop, colorGroupCommand, createGroupCommand, deleteGroupCommand,
  renameGroupCommand, runGroupAction, soundGroupCommand, soundSessionCommand,
} from './groups/commands';
import { colorChoice, GROUP_COLORS, NO_COLOR_LABEL } from './ui/colors';
import { readGroups } from './groups/store';
import { CHIME_EVENTS, soundFor } from './groups/model';
import { installedCount, installLibrary, LIBRARY, librarySoundsDir, removeLibrary } from './sound/library';
import type { TranscriptStats } from './transcript/reader';
import { withTokens } from './transcript/tokens';
import { SessionsTree, groupIdOfNode, sessionIdOfNode } from './ui/tree';
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
  const settingsPath = settingsFile(home);
  const closedPath = closedFile(home);
  await ensureDirs(dirs);
  if (migrated === 'migrated') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Koh-Vibe: the extension was renamed. Your folders and sessions were carried over; run "Install hooks" again so that Claude Code points at the new bridge.',
      ),
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
   * Les réglages du son, tenus dans un fichier PARTAGÉ entre éditeurs.
   *
   * Ils vivaient dans les réglages VSCode, donc dans ceux de chaque éditeur pris
   * séparément : la même machine annonçait « Chute 3 » d'un côté et « Funk » de
   * l'autre. Le classement en dossiers avait déjà tranché la question, et il n'y
   * avait aucune raison que le son y échappe.
   *
   * Relus à chaque rendu et gardés ici : le carillon et les lignes de réglage en
   * ont besoin de façon synchrone, au milieu d'un tour déjà asynchrone.
   */
  let sound: AppSettings = defaultSettings();

  function soundSettings(): SoundSettings {
    return sound;
  }

  /** Ce que cet éditeur avait chez lui, et qui ne servira qu'une fois. */
  function legacySettings(): AppSettings {
    const config = vscode.workspace.getConfiguration('kohVibe');
    const name = (key: string): string => {
      const value = config.get(key);
      return typeof value === 'string' ? value : NO_SOUND;
    };
    return { waiting: name('sound.waiting'), done: name('sound.done'), volume: clampVolume(config.get('sound.volume')) };
  }

  // Référence du tour précédent pour le carillon. `undefined` = premier rendu :
  // tout y ressemblerait à une transition, et l'éditeur carillonnerait à chaque
  // ouverture de fenêtre pour des sessions parfois vieilles de plusieurs heures.
  let lastStatuses: Map<string, Session['status']> | undefined;

  /** Ce que rejoue la flèche droite, posé le temps d'un choix de son. */
  const PICKING_SOUND = 'kohVibe.pickingSound';

  // Ces libellés sont comparés à ce que l'utilisateur a choisi : les nommer une
  // fois empêche qu'une traduction fasse diverger la question de sa réponse.
  const NONE_LABEL = vscode.l10n.t('None');
  const INSTALL_LABEL = vscode.l10n.t('Install');
  let replay: (() => void) | undefined;

  /**
   * Choisit un son, en le faisant entendre au fil des flèches.
   *
   * `inherit` nomme le niveau au-dessus : « Réglage global » pour un dossier,
   * « Son du dossier » pour une conversation. Le retirer est un choix, distinct
   * de fermer la liste — d'où le retour `{ sound }` plutôt qu'une chaîne, qui
   * confondrait « aucun » et « annulé ».
   */
  async function pickSound(
    title: string,
    inherit: string | undefined,
  ): Promise<{ sound: string | undefined } | undefined> {
    const sounds = await availableSounds();
    if (sounds.length === 0) {
      const go = await vscode.window.showInformationMessage(
        vscode.l10n.t('Koh-Vibe: no sound found on this machine.'),
        vscode.l10n.t('Install the library'),
      );
      if (go !== undefined) await vscode.commands.executeCommand('kohVibe.installSounds');
      return undefined;
    }
    const volume = soundSettings().volume;
    // `createQuickPick` et non `showQuickPick` : lui seul expose
    // `onDidChangeActive`, donc le survol au clavier. Choisir un son sans
    // l'entendre oblige à attendre une vraie bascule pour savoir ce qu'on a pris.
    const picker = vscode.window.createQuickPick();
    picker.title = title;
    picker.placeholder = vscode.l10n.t('The arrow keys play each sound; → replays it');
    picker.items = [
      ...(inherit === undefined
        ? []
        : [{ label: inherit, description: vscode.l10n.t('set nothing at this level') }]),
      { label: NONE_LABEL, description: vscode.l10n.t('silence, even if the level above has a sound') },
      ...sounds.map((s) => ({ label: s.name, description: s.path })),
    ];
    const hear = (label: string | undefined): void => {
      if (label === undefined || label === inherit || label === NONE_LABEL) return;
      void playNamed(label, volume);
    };
    picker.onDidChangeActive((active) => hear(active[0]?.label));
    // La flèche droite ne traverse pas l'API : VSCode n'expose aucun événement
    // clavier sur une liste de choix. Le seul chemin est une commande liée à la
    // touche, activée par un contexte que l'on ne lève QUE pendant ce choix —
    // sans quoi la flèche droite cesserait de déplacer le curseur partout
    // ailleurs dans l'éditeur.
    replay = () => hear(picker.activeItems[0]?.label);
    await vscode.commands.executeCommand('setContext', PICKING_SOUND, true);
    let chosen: string | undefined;
    try {
      chosen = await new Promise<string | undefined>((resolve) => {
        picker.onDidAccept(() => resolve(picker.selectedItems[0]?.label));
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
    } finally {
      // Quoi qu'il arrive : un contexte resté levé rendrait la flèche droite
      // inerte dans tout l'éditeur, sans que rien ne dise pourquoi.
      replay = undefined;
      await vscode.commands.executeCommand('setContext', PICKING_SOUND, false);
      picker.dispose();
    }
    if (chosen === undefined) return undefined;
    if (chosen === inherit) return { sound: undefined };
    return { sound: chosen === NONE_LABEL ? NO_SOUND : chosen };
  }

  const tree = new SessionsTree(checkHooksInstalled, onSessionsDropped, context.extensionPath);
  const footer = new FooterTree();
  const usageView = new UsageView(() => void vscode.commands.executeCommand('kohVibe.refreshUsage'));
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
    // Trois vues empilées dans le conteneur : les sessions, la consommation,
    // puis les réglages. L'ordre vient de package.json, pas d'ici.
    vscode.window.registerWebviewViewProvider('kohVibe.usage', usageView),
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
        usageView.setUsage(await readUsage(home));
        sound = await readSettings(settingsPath);
        footer.setSound(sound);
        footer.setLibrary(await installedCount(librarySoundsDir(home)));
        const map = await withTokens(await readSessions(dirs), transcripts, () => {
          if (transcriptFailureWarned) return;
          transcriptFailureWarned = true;
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Koh-Vibe: a transcript could not be read — this session is shown without its counters.',
            ),
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
        const changed = chimeFor(lastStatuses, statuses);
        if (changed !== undefined) {
          const global = changed.event === 'waiting' ? sound.waiting : sound.done;
          // Le son de la conversation l'emporte, puis celui de son dossier, puis
          // le réglage global — voir `soundFor`.
          void playNamed(soundFor(groups, changed.sessionId, changed.event, global), sound.volume);
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
          vscode.l10n.t('Koh-Vibe: rendering the dashboard failed — it will be retried.'),
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
        vscode.l10n.t('Koh-Vibe: reading the events failed — it will be retried.'),
      );
    },
    Date.now,
    // The closed-conversation history. Errors are NOT swallowed here: `drain`
    // relies on the rejection to leave the event in place and retry it.
    (s) => rememberClosed(closedPath, toClosedEntry(s, Date.now())).then(() => undefined),
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
      // Proposé ici, une seule fois, et jamais imposé : c'est le moment où l'on
      // installe, donc le moment où la question a un sens. `void` — la question
      // ne doit pas retarder l'installation elle-même.
      void vscode.commands.executeCommand('kohVibe.offerSounds');
    }),
    vscode.commands.registerCommand('kohVibe.offerSounds', async () => {
      // Rien à proposer si la bibliothèque est déjà posée : une question sans
      // objet est du bruit.
      if ((await installedCount(librarySoundsDir(home))) > 0) return;
      const go = await vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Koh-Vibe can install {0} short interface sounds ({1}, {2}).',
          LIBRARY.count,
          LIBRARY.name,
          LIBRARY.license,
        ),
        INSTALL_LABEL,
        vscode.l10n.t('Later'),
      );
      if (go === INSTALL_LABEL) await vscode.commands.executeCommand('kohVibe.installSounds');
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
      const label = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Folder name'),
        placeHolder: vscode.l10n.t('Personal'),
      });
      await runGroupAction(
        () => createGroupCommand(groupsPath, label, () => randomUUID()),
        (message) => void vscode.window.showErrorMessage(message),
      );
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.renameGroup', async (node: unknown) => {
      const id = groupIdOfNode(node);
      if (id === undefined) return;
      const label = await vscode.window.showInputBox({ prompt: vscode.l10n.t('New folder name') });
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
          vscode.l10n.t(
            'Koh-Vibe: usage unavailable — Anthropic unreachable, or keychain access denied.',
          ),
        );
      }
    }),
    vscode.commands.registerCommand('kohVibe.replaySound', () => replay?.()),
    vscode.commands.registerCommand('kohVibe.chooseSound', async (event: unknown) => {
      const which: ChimeEvent = event === 'done' ? 'done' : 'waiting';
      // Pas de niveau au-dessus : c'est le réglage global, le dernier recours.
      const chosen = await pickSound(EVENT_TITLE[which](), undefined);
      if (chosen === undefined) return;
      await writeSettings(settingsPath, { [which]: chosen.sound ?? NO_SOUND });
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
      picker.title = vscode.l10n.t('Chime volume');
      picker.placeholder = vscode.l10n.t('The arrow keys play each level');
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
      await writeSettings(settingsPath, { volume: Number.parseInt(chosen, 10) / 100 });
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.installSounds', async () => {
      const target = librarySoundsDir(home);
      const already = await installedCount(target);
      if (already > 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Koh-Vibe: the library is already installed ({0} sounds).', already),
        );
        return;
      }
      const go = await vscode.window.showInformationMessage(
        vscode.l10n.t('Install {0} interface sounds?', LIBRARY.count),
        {
          modal: true,
          detail: vscode.l10n.t(
            '{0}, by {1} — {2}, so free for any use.\nAround 2 MB downloaded once (3 MB on disk), placed in {3}, and removable in one click.',
            LIBRARY.name,
            LIBRARY.author,
            LIBRARY.license,
            target,
          ),
        },
        INSTALL_LABEL,
      );
      if (go !== INSTALL_LABEL) return;
      const added = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Koh-Vibe: installing sounds…') },
        () => installLibrary(target),
      );
      void vscode.window.showInformationMessage(
        added === 0
          ? vscode.l10n.t('Koh-Vibe: the library could not be installed — network unreachable?')
          : vscode.l10n.t('Koh-Vibe: {0} sounds installed.', added),
      );
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.removeSounds', async () => {
      const target = librarySoundsDir(home);
      const present = await installedCount(target);
      if (present === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Koh-Vibe: the library is not installed.'));
        return;
      }
      const remove = vscode.l10n.t('Remove');
      const go = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove the {0} sounds of the library?', present),
        {
          modal: true,
          detail: vscode.l10n.t(
            'Only {0} is erased: the system sounds and your own stay put.',
            target,
          ),
        },
        remove,
      );
      if (go !== remove) return;
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Koh-Vibe: {0} sounds removed.', await removeLibrary(target)),
      );
      await render();
    }),
    // Deux commandes par niveau, une par événement, plutôt qu'une seule qui
    // demanderait ensuite « lequel ? » : le menu doit dire ce qu'on va régler
    // avant de l'ouvrir, sinon on choisit un son sans savoir quand il sonnera.
    ...CHIME_EVENTS.flatMap((event) => [
      vscode.commands.registerCommand(`kohVibe.soundGroup.${event}`, async (node: unknown) => {
        const id = groupIdOfNode(node);
        if (id === undefined) return;
        const chosen = await pickSound(vscode.l10n.t('{0} — this folder', EVENT_TITLE[event]()), vscode.l10n.t('Global setting'));
        if (chosen === undefined) return;
        await runGroupAction(
          () => soundGroupCommand(groupsPath, id, event, chosen.sound),
          (message) => void vscode.window.showErrorMessage(message),
        );
        await render();
      }),
      vscode.commands.registerCommand(`kohVibe.soundSession.${event}`, async (node: unknown) => {
        const id = sessionIdOfNode(node);
        if (id === undefined) return;
        const chosen = await pickSound(vscode.l10n.t('{0} — this conversation', EVENT_TITLE[event]()),
          vscode.l10n.t('Folder sound'),
        );
        if (chosen === undefined) return;
        await runGroupAction(
          () => soundSessionCommand(groupsPath, id, event, chosen.sound),
          (message) => void vscode.window.showErrorMessage(message),
        );
        await render();
      }),
    ]),
    /**
     * Retire une conversation du tableau de bord.
     *
     * Ne tue rien : Claude Code tourne dans son terminal, et cette extension
     * n'en connaît que les traces. Une session ENCORE VIVANTE réapparaîtra donc
     * à son prochain événement — c'est voulu, et le libellé du menu le dit
     * (« retirer de la liste », pas « fermer »), plutôt que de laisser croire à
     * un arrêt qui n'a pas eu lieu.
     */
    vscode.commands.registerCommand('kohVibe.forgetSession', async (node: unknown) => {
      const id = sessionIdOfNode(node);
      if (id === undefined) return;
      try {
        await removeSession(dirs, id);
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t('Koh-Vibe: this conversation could not be removed.'));
        return;
      }
      // Son rangement part avec elle : dossier, place choisie, sons propres.
      // Le laisser ferait ressurgir un classement fantôme si l'identifiant
      // revenait, et gonflerait le fichier partagé sans fin.
      await pruneAssignmentsAfterPurge(dirs, groupsPath, [id]).catch(() => undefined);
      await render();
    }),
    vscode.commands.registerCommand('kohVibe.colorGroup', async (node: unknown) => {
      const id = groupIdOfNode(node);
      if (id === undefined) return;
      const pick = await vscode.window.showQuickPick(
        [NO_COLOR_LABEL, ...GROUP_COLORS.map((c) => c.label)],
        { placeHolder: vscode.l10n.t('Folder colour') },
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

  // Avant le premier rendu : le fichier partagé n'existe pas encore chez qui
  // vient de mettre à jour, et il faut y verser ce que CET éditeur avait dans
  // ses propres réglages. Le premier démarré fixe la valeur ; les suivants la
  // lisent — voir seedSettings, qui ne réécrit jamais un fichier présent.
  await seedSettings(settingsPath, legacySettings);
  await render();
}

export function deactivate(): void {
  // Toutes les ressources sont enregistrées dans context.subscriptions.
}
