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

/**
 * Assez fidèle pour ce que la vue en fait : `Uri.from` conserve les champs et
 * `toString` les recompose. Le bouchon ne cherche pas à reproduire l'encodage
 * complet de VSCode — les tests portent sur ce que l'arbre POSE, et la lecture
 * de l'URI est éprouvée à part, sur une fonction pure (ui/decorations.ts).
 */
export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
  ) {}

  static from(parts: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '');
  }

  /** Ce que SessionsTree appelle pour ses pastilles de statut. */
  static file(path: string): Uri {
    return new Uri('file', '', path, '');
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}?${this.query}`;
  }
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

/**
 * Translation, stubbed to the identity.
 *
 * `vscode.l10n.t` returns the source string whenever the running editor has no
 * bundle for its language — which is exactly what happens in English, the
 * language the sources are written in. Tests therefore assert the English
 * strings, and they assert them through the same call the extension makes.
 */
export const l10n = {
  t(message: string, ...args: Array<string | number>): string {
    return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? whole : String(value);
    });
  },
};

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

// Couvre exactement ce dont SessionsTree.handleDrag/handleDrop ont besoin :
// poser une valeur sous un type MIME, la relire sous ce même type. `value`
// est typé `unknown` (la vraie API le déclare `any`) pour que le code qui le
// lit soit obligé de le valider avant usage, jamais de le caster.
export class DataTransferItem {
  constructor(public readonly value: unknown) {}
}

export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();

  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType);
  }

  set(mimeType: string, item: DataTransferItem): void {
    this.items.set(mimeType, item);
  }
}
