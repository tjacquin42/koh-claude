#!/usr/bin/env node
/**
 * Fabrique les pastilles de statut de la barre latérale — un SVG par statut et
 * par famille de thème.
 *
 * Pourquoi des fichiers plutôt qu'un codicon coloré : voir src/ui/status-icon.ts.
 * En deux mots, VSCode force `color: currentColor !important` sur l'icône d'une
 * ligne SÉLECTIONNÉE, mais seulement quand c'est un codicon. Une image y échappe.
 *
 * Pourquoi un générateur plutôt que dix fichiers écrits à la main : la table
 * ci-dessous est la source. Corriger une teinte, ou ajouter un statut, veut dire
 * toucher une ligne — pas relire dix SVG pour vérifier qu'ils ont bien le même
 * cercle. Même principe que scripts/make-icons.cjs.
 *
 * Usage : node scripts/make-status-icons.cjs
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Les valeurs par DÉFAUT des couleurs de VSCode que portait chaque statut du
 * temps des `ThemeIcon` — relevées dans son registre plutôt que choisies ici,
 * pour que le passage à l'image ne change pas l'apparence hors sélection.
 *
 *   running     charts.blue    → editorInfo.foreground
 *   done_unseen charts.green
 *   idle        descriptionForeground   (le thème sombre l'obtient à 70 % du texte)
 *   stale       disabledForeground      (…et celui-ci à 50 %, d'où l'opacité)
 *
 * Une seule exception, assumée : `waiting` était `charts.yellow`, un or foncé
 * (#CCA700) qui se lit mal comme une alerte — or c'est le seul statut qui
 * demande quelque chose à l'utilisateur, et le seul qui ne se résoudra pas tout
 * seul. Il passe donc à l'orange. Surtout pas `charts.orange`, qui vaut
 * `#EA5C0055` : une couleur de FOND de surlignage, à 33 % d'opacité, délavée en
 * pastille pleine. Les deux valeurs ci-dessous sont des oranges opaques, tenus
 * au-dessus de 3:1 sur leur fond respectif — le seuil WCAG d'un élément
 * graphique porteur de sens.
 *
 * L'opacité est portée par le SVG parce qu'elle fait partie de la couleur :
 * `#CCCCCC80` est un canal alpha dans le registre de VSCode, pas une nuance de gris.
 */
const PALETTE = {
  running: { dark: ['#59A4F9', 1], light: ['#0063D3', 1] },
  waiting: { dark: ['#D18616', 1], light: ['#C4700E', 1] },
  done_unseen: { dark: ['#89D185', 1], light: ['#388A34', 1] },
  idle: { dark: ['#CCCCCC', 0.7], light: ['#717171', 1] },
  stale: { dark: ['#CCCCCC', 0.5], light: ['#616161', 0.5] },
};

// 16 px est la taille à laquelle VSCode affiche l'icône d'une ligne d'arbre
// (`background-size: 16px`), et 4.5 le rayon qui redonne au disque l'encombrement
// du codicon `circle-filled` qu'il remplace — une pastille plus grosse décalerait
// l'œil d'une ligne à l'autre pendant la transition.
const SIZE = 16;
const RADIUS = 4.5;

function disc([fill, opacity]) {
  const alpha = opacity === 1 ? '' : ` fill-opacity="${opacity}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${RADIUS}" fill="${fill}"${alpha}/>` +
    `</svg>\n`
  );
}

const dir = join(__dirname, '..', 'resources', 'status');
mkdirSync(dir, { recursive: true });

for (const [status, themes] of Object.entries(PALETTE)) {
  for (const [theme, color] of Object.entries(themes)) {
    // Le nom doit rester celui que calcule statusIconPath() : le statut avec ses
    // tirets bas changés en tirets, puis le thème. Un test vérifie que chaque
    // chemin annoncé existe pour de vrai.
    const file = join(dir, `${status.replace('_', '-')}-${theme}.svg`);
    writeFileSync(file, disc(color), 'utf8');
    console.log(`écrit ${file.slice(file.indexOf('resources'))}`);
  }
}
