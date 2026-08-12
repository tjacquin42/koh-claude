#!/usr/bin/env node
// Installe ou désinstalle les hooks koh-claude dans ~/.claude/settings.json.
//   node scripts/install-hooks.cjs --bridge <chemin>
//   node scripts/install-hooks.cjs --uninstall
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const {
  countForeignEntries,
  countKohEntries,
  installHooks,
  uninstallHooks,
} = require('../out/hooks/installer.js');

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const BACKUPS = join(homedir(), '.koh-claude', 'backups');
const uninstall = process.argv.includes('--uninstall');
const bridgeArg = process.argv.indexOf('--bridge');
const bridge =
  bridgeArg > -1 ? process.argv[bridgeArg + 1] : join(process.cwd(), 'bin/koh-claude-bridge');

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Détecte l'indentation et la présence d'un retour à la ligne final du fichier
 * d'origine, pour réécrire dans le même style plutôt que d'imposer le nôtre : un
 * fichier indenté à quatre espaces ne doit pas revenir reformaté à deux.
 */
function detectStyle(raw) {
  const match = /^[ \t]+/m.exec(raw);
  return { indent: match ? match[0] : 2, newline: raw.endsWith('\n') };
}

let raw;
let creating = false;
if (existsSync(SETTINGS)) {
  raw = readFileSync(SETTINGS, 'utf8');
} else {
  creating = true;
  raw = '{}';
}

let before;
try {
  before = JSON.parse(raw);
} catch (err) {
  fail(`JSON invalide dans ${SETTINGS} : ${err.message}\nRien n'a été écrit.`);
  return; // fail() quitte le process ; le return est une garde en plus, pas un besoin
}

const style = creating ? { indent: 2, newline: true } : detectStyle(raw);
const after = uninstall ? uninstallHooks(before) : installHooks(before, bridge);

// Garde-fou : si des commandes qui ne sont pas les nôtres ont disparu pendant la
// transformation, on refuse d'écrire plutôt que de risquer de perdre l'outillage
// d'un autre programme (ex. Vibe Island). C'est le filet qui aurait attrapé une
// régression comme celle relevée en revue sur les formes non reconnues.
const foreignBefore = countForeignEntries(before);
const foreignAfter = countForeignEntries(after);
if (foreignAfter !== foreignBefore) {
  fail(
    `Refus d'écrire : ${foreignBefore} commande(s) étrangère(s) avant la transformation, ` +
      `${foreignAfter} après. Quelque chose qui n'est pas à nous aurait disparu. Rien n'a été écrit.`,
  );
}

if (creating) {
  console.log(`${SETTINGS} n'existe pas : il sera créé.`);
  mkdirSync(dirname(SETTINGS), { recursive: true });
} else {
  mkdirSync(BACKUPS, { recursive: true });
  const backup = join(BACKUPS, `settings-${Date.now()}.json`);
  copyFileSync(SETTINGS, backup);
  console.log(`Sauvegarde : ${backup}`);
}

// Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau,
// jamais un fichier à moitié écrit.
const serialized = JSON.stringify(after, null, style.indent);
const tmp = join(dirname(SETTINGS), `.tmp-settings-${process.pid}`);
writeFileSync(tmp, style.newline ? `${serialized}\n` : serialized, 'utf8');
renameSync(tmp, SETTINGS);

console.log(`Entrées koh-claude : ${countKohEntries(before)} → ${countKohEntries(after)}`);
