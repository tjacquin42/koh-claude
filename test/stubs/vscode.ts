// Bouchon minimal de l'API `vscode`, utilisé uniquement en test (alias vitest,
// voir vitest.config.ts : `vscode` est résolu vers ce fichier plutôt que vers
// le module réel, qui n'existe qu'à l'intérieur de l'hôte d'extensions).
//
// Couvre exactement ce dont `FocusBroker` et `SessionsTree` ont besoin pour
// être testés sans lancer VSCode — à étendre au fur et à mesure d'un besoin
// réel, jamais par anticipation. `getTreeItem` (qui construit des `TreeItem`,
// `ThemeIcon`, `ThemeColor`) n'est pas exercé par les tests actuels ; ces
// classes sont quand même fournies, minimales, pour que le module qui les
// importe reste chargeable.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: (): void => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(e: T): void {
    for (const listener of this.listeners) listener(e);
  }

  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

export interface TreeItemCommand {
  command: string;
  title: string;
  arguments?: unknown[];
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  accessibilityInformation?: { label: string };
  iconPath?: unknown;
  command?: TreeItemCommand;

  constructor(
    public readonly label: string,
    public readonly collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export const window = {
  showInformationMessage: async (..._args: unknown[]): Promise<string | undefined> => undefined,
  showWarningMessage: async (..._args: unknown[]): Promise<string | undefined> => undefined,
  createTreeView: (..._args: unknown[]): never => {
    throw new Error('vscode.window.createTreeView non bouchonné');
  },
  createTerminal: (..._args: unknown[]): never => {
    throw new Error('vscode.window.createTerminal non bouchonné');
  },
};

export const workspace: { workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined } = {
  workspaceFolders: undefined,
};

export const commands = {
  executeCommand: async (..._args: unknown[]): Promise<unknown> => undefined,
  registerCommand: (..._args: unknown[]): { dispose: () => void } => ({ dispose: () => undefined }),
};
