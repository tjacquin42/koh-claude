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
  | { kind: 'volume'; volume: number };

const EVENT_FR: Record<ChimeEvent, string> = {
  waiting: "t'attend",
  done: 'terminé',
};

/** Le libellé dit l'état courant, pas une invitation vague : « Son … : Ping » se lit d'un coup d'œil. */
export function soundRowLabel(event: ChimeEvent, name: string): string {
  return `Son ${EVENT_FR[event]} : ${name === NO_SOUND ? 'aucun' : name}`;
}

export function volumeRowLabel(volume: number): string {
  return `Volume : ${Math.round(volume * 100)} %`;
}

export class FooterTree implements vscode.TreeDataProvider<FooterNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sound: SoundSettings = { waiting: NO_SOUND, done: NO_SOUND, volume: 0.5 };
  // Même règle que l'arbre des sessions : ne rien annoncer quand rien n'a
  // changé, sinon l'infobulle s'escamote sous la souris.
  private rendered: string | undefined;

  setSound(sound: SoundSettings): void {
    this.sound = sound;
    this.refresh();
  }

  private refresh(): void {
    const next = JSON.stringify(this.sound);
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
    ];
  }

  getTreeItem(node: FooterNode): vscode.TreeItem {
    if (node.kind === 'sound') {
      const item = new vscode.TreeItem(soundRowLabel(node.event, node.name));
      item.tooltip =
        node.event === 'waiting'
          ? "Joué quand une session se met à attendre ta réponse.\nCliquez pour choisir ; les flèches font entendre chaque son."
          : "Joué quand une session vient de finir.\nCliquez pour choisir ; les flèches font entendre chaque son.";
      item.iconPath = new vscode.ThemeIcon(
        node.name === NO_SOUND ? 'mute' : 'unmute',
        new vscode.ThemeColor('descriptionForeground'),
      );
      item.command = { command: 'kohVibe.chooseSound', title: 'Choisir le son', arguments: [node.event] };
      return item;
    }
    const item = new vscode.TreeItem(volumeRowLabel(node.volume));
    item.tooltip = 'Volume des carillons.\nCliquez pour le régler ; chaque pas se fait entendre.';
    item.iconPath = new vscode.ThemeIcon('megaphone', new vscode.ThemeColor('descriptionForeground'));
    item.command = { command: 'kohVibe.chooseVolume', title: 'Régler le volume' };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
