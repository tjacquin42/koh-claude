import * as vscode from 'vscode';
import type { UsageReading, UsageSource } from '../usage/reader';
import type { Usage, UsageWindow } from '../usage/model';

/**
 * La consommation, en vue web plutôt qu'en arbre.
 *
 * Une ligne d'arbre ne se colore que d'un bloc : VSCode n'offre ni segment ni
 * style dans un libellé. Or ce qu'on veut dire tient précisément dans le
 * contraste — le nom de la fenêtre en clair, le pourcentage coloré selon ce
 * qu'il vaut, l'échéance en retrait. Une vue web est le seul endroit où cette
 * distinction existe.
 *
 * Toutes les couleurs sortent des variables de thème de l'éditeur, jamais d'un
 * code en dur : la vue doit suivre le thème clair comme le sombre.
 */
const GREEN_UNTIL = 50;
const ORANGE_UNTIL = 80;

/** Vert jusqu'à 50 %, orange jusqu'à 80 %, rouge au-delà. */
export function percentColor(percent: number): string {
  if (percent <= GREEN_UNTIL) return 'var(--vscode-charts-green)';
  if (percent <= ORANGE_UNTIL) return 'var(--vscode-charts-orange)';
  return 'var(--vscode-charts-red)';
}

/**
 * « dans 2 h », « dans 6 j » — le délai avant remise à zéro, arrondi vers le
 * bas comme partout ailleurs : une échéance se lit vers le bas, jamais vers le
 * haut, sinon on croit avoir plus de temps qu'on en a.
 */
export function resetText(w: UsageWindow | undefined, now: number): string {
  if (w?.resetsAt === undefined) return '';
  const remaining = w.resetsAt * 1000 - now;
  if (remaining <= 0) return vscode.l10n.t('reset');
  const hours = Math.floor(remaining / 3_600_000);
  if (hours < 1) return vscode.l10n.t('in {0} min', Math.max(1, Math.floor(remaining / 60_000)));
  if (hours < 24) return vscode.l10n.t('in {0} h', hours);
  return vscode.l10n.t('in {0} d', Math.floor(hours / 24));
}

const SOURCE: Record<UsageSource, () => string> = {
  api: () => 'Anthropic',
  statusline: () => vscode.l10n.t('Claude Code status line'),
};

/**
 * Escapes everything the view interpolates, with no exception for its own
 * labels — because they are not its own once translated. English has no
 * apostrophe in "just now"; French does, and so do quotation marks in German.
 * A label is untrusted input the moment it can come from a bundle.
 */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function row(label: string, w: UsageWindow | undefined, now: number): string {
  if (w === undefined) return '';
  const percent = Math.round(w.percent);
  const reset = resetText(w, now);
  return `<div class="row">
    <span class="kind">${escape(label)}</span>
    <span class="pct" style="color:${percentColor(percent)}">${percent} %</span>
    ${reset === '' ? '' : `<span class="dot">•</span><span class="reset">${escape(reset)}</span>`}
  </div>`;
}

/** Le corps de la vue, séparé du webview pour être éprouvable sans éditeur. */
export function usageHtml(reading: UsageReading | undefined, now: number): string {
  const body =
    reading === undefined
      ? `<div class="empty">Consommation inconnue — cliquez pour rafraîchir.</div>`
      : rowsOf(reading.usage, now) + footer(reading, now);
  return `<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); padding: 4px 12px 8px; }
    .row { display: flex; align-items: baseline; gap: 8px; line-height: 22px; white-space: nowrap; }
    .kind { color: var(--vscode-foreground); width: 2.2em; }
    .pct { font-variant-numeric: tabular-nums; text-align: right; width: 3.5em; }
    .dot, .reset, .src, .empty { color: var(--vscode-descriptionForeground); }
    .src { display: block; margin-top: 6px; font-size: 0.9em; }
    a { color: inherit; text-decoration: none; cursor: pointer; display: block; }
  </style>
  <a id="refresh" title="${escape(vscode.l10n.t('Click to refresh'))}">${body}</a>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  </script>`;
}

function rowsOf(u: Usage, now: number): string {
  // The window names are abbreviations of durations, and abbreviations differ:
  // French writes days "j", English "d".
  return row(vscode.l10n.t('5 h'), u.fiveHour, now) + row(vscode.l10n.t('7 d'), u.sevenDay, now);
}

function footer(reading: UsageReading, now: number): string {
  const age = Math.max(0, Math.floor((now - reading.at) / 60_000));
  const when = age < 1 ? vscode.l10n.t('just now') : vscode.l10n.t('{0} min ago', age);
  return `<span class="src">${escape(SOURCE[reading.source]())} · ${escape(when)}</span>`;
}

export class UsageView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private reading: UsageReading | undefined;
  private rendered: string | undefined;

  constructor(private readonly onRefresh: () => void) {}

  setUsage(reading: UsageReading | undefined): void {
    this.reading = reading;
    this.paint();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(() => this.onRefresh());
    // Forcer le rendu : la vue vient d'apparaître, elle n'a encore rien affiché.
    this.rendered = undefined;
    this.paint();
  }

  private paint(): void {
    if (this.view === undefined) return;
    const html = usageHtml(this.reading, Date.now());
    // Même règle que les arbres : ne rien réécrire quand rien n'a changé. Un
    // webview réécrit perd sa sélection et son survol.
    if (html === this.rendered) return;
    this.rendered = html;
    this.view.webview.html = html;
  }
}
