import * as vscode from 'vscode';
import { NO_SOUND } from '../sound/player';
import type { ChimeEvent } from '../sound/model';

/**
 * Les réglages, dans une vue SÉPARÉE de la liste des sessions.
 *
 * VSCode n'offre aucun moyen d'épingler une ligne au bas d'un arbre : tout ce
 * qu'on y met défile avec le reste. Une seconde vue dans le même conteneur, en
 * revanche, se pose sous la première et n'en suit pas le défilement — c'est le
 * seul « fixé en bas » que la plateforme permette.
 */
export interface SoundSettings {
  waiting: string;
  done: string;
  volume: number;
}

export type FooterNode =
  | { kind: 'sound'; event: ChimeEvent; name: string }
  | { kind: 'volume'; volume: number }
  | { kind: 'library'; count: number };

/**
 * The title of a sound picker. It names the EVENT, not the level: "sound of
 * this folder" never said what was being set, and the level is already visible
 * in the menu you came through.
 */
export const EVENT_TITLE: Record<ChimeEvent, () => string> = {
  waiting: () => vscode.l10n.t('Sound when a session waits for you'),
  done: () => vscode.l10n.t('Sound when a session finishes'),
};

/** How many sounds the library has laid down, hence whether to install or remove it. */
export function libraryRowLabel(count: number): string {
  return count === 0
    ? vscode.l10n.t('Sound library: install…')
    : vscode.l10n.t('Sound library: {0} sounds', count);
}

/** The row states the current setting rather than vaguely inviting one: "…: Ping" reads at a glance. */
export function soundRowLabel(event: ChimeEvent, name: string): string {
  const sound = name === NO_SOUND ? vscode.l10n.t('none') : name;
  return event === 'waiting'
    ? vscode.l10n.t('Waiting sound: {0}', sound)
    : vscode.l10n.t('Finished sound: {0}', sound);
}

export function volumeRowLabel(volume: number): string {
  return vscode.l10n.t('Volume: {0} %', Math.round(volume * 100));
}

export class FooterTree implements vscode.TreeDataProvider<FooterNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sound: SoundSettings = { waiting: NO_SOUND, done: NO_SOUND, volume: 0.5 };
  private library = 0;
  // Même règle que l'arbre des sessions : ne rien annoncer quand rien n'a
  // changé, sinon l'infobulle s'escamote sous la souris.
  private rendered: string | undefined;

  setSound(sound: SoundSettings): void {
    this.sound = sound;
    this.refresh();
  }

  setLibrary(count: number): void {
    this.library = count;
    this.refresh();
  }

  private refresh(): void {
    const next = JSON.stringify([this.sound, this.library]);
    if (next === this.rendered) return;
    this.rendered = next;
    this.emitter.fire();
  }

  getChildren(node?: FooterNode): FooterNode[] {
    if (node !== undefined) return [];
    return [
      { kind: 'sound', event: 'waiting', name: this.sound.waiting },
      { kind: 'sound', event: 'done', name: this.sound.done },
      { kind: 'volume', volume: this.sound.volume },
      { kind: 'library', count: this.library },
    ];
  }

  getTreeItem(node: FooterNode): vscode.TreeItem {
    if (node.kind === 'sound') {
      const item = new vscode.TreeItem(soundRowLabel(node.event, node.name));
      item.tooltip =
        node.event === 'waiting'
          ? vscode.l10n.t(
              'Played when a session starts waiting for your answer.\nClick to choose; the arrow keys play each sound.',
            )
          : vscode.l10n.t(
              'Played when a session has just finished.\nClick to choose; the arrow keys play each sound.',
            );
      item.iconPath = new vscode.ThemeIcon(
        node.name === NO_SOUND ? 'mute' : 'unmute',
        new vscode.ThemeColor('descriptionForeground'),
      );
      item.command = { command: 'kohVibe.chooseSound', title: EVENT_TITLE[node.event](), arguments: [node.event] };
      return item;
    }
    if (node.kind === 'volume') {
      const item = new vscode.TreeItem(volumeRowLabel(node.volume));
      item.tooltip = vscode.l10n.t('Chime volume.\nClick to set it; every step is played.');
      item.iconPath = new vscode.ThemeIcon('megaphone', new vscode.ThemeColor('descriptionForeground'));
      item.command = { command: 'kohVibe.chooseVolume', title: vscode.l10n.t('Set the volume') };
      return item;
    }
    const item = new vscode.TreeItem(libraryRowLabel(node.count));
    item.tooltip =
      node.count === 0
        ? vscode.l10n.t('A hundred short interface sounds, free of rights, downloaded once.')
        : vscode.l10n.t('Click to remove the library. Your own sounds and the system ones stay put.');
    item.iconPath = new vscode.ThemeIcon('library', new vscode.ThemeColor('descriptionForeground'));
    item.command = {
      command: node.count === 0 ? 'kohVibe.installSounds' : 'kohVibe.removeSounds',
      title: vscode.l10n.t('Sound library'),
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
