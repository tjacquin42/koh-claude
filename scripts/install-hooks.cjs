#!/usr/bin/env node
// Installe ou désinstalle les hooks koh-claude dans ~/.claude/settings.json.
//   node scripts/install-hooks.cjs --bridge <chemin>
//   node scripts/install-hooks.cjs --uninstall
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const {
  countKohEntries,
  foreignFingerprint,
  installHooks,
  uninstallHooks,
} = require('../out/hooks/installer.js');
const { kohClaudeHome, spoolDirs } = require('../out/paths.js');

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const HOME = kohClaudeHome();
const BACKUPS = spoolDirs(HOME).backups;
const uninstall = process.argv.includes('--uninstall');
const bridgeArg = process.argv.indexOf('--bridge');
// Source à copier, jamais la cible des hooks. Résolue à côté du script lui-même,
// jamais du cwd : ainsi le script fonctionne identiquement lancé depuis le dépôt
// (scripts/ et bin/ sont frères) ou depuis l'extension installée (même
// arborescence dans le .vsix, cf. .vscodeignore).
const bridgeSource =
  bridgeArg > -1 ? process.argv[bridgeArg + 1] : join(__dirname, '..', 'bin', 'koh-claude-bridge');
// Cible stable, sous kohClaudeHome() : ni le dépôt ni l'extension installée ne
// sont des emplacements stables (le premier peut être déplacé ou supprimé, la
// seconde est un dossier versionné qui disparaît à la prochaine mise à jour).
// Les hooks pointent toujours vers cette copie, jamais vers la source.
const bridgeTarget = join(HOME, 'bin', 'koh-claude-bridge');

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

if (!uninstall && !existsSync(bridgeSource)) {
  fail(`Bridge introuvable : ${bridgeSource}\nRien n'a été écrit.`);
}

const style = creating ? { indent: 2, newline: true } : detectStyle(raw);
const after = uninstall ? uninstallHooks(before) : installHooks(before, bridgeTarget);

// Garde-fou : un compte ne peut pas prouver une conservation (deux arbres où une
// commande étrangère a changé de place, ou a été perdue en même temps qu'une autre
// apparaissait, peuvent partager le même compte). On compare donc une empreinte —
// chaque commande étrangère qualifiée par son ascendance — avant et après la
// transformation, et on refuse d'écrire au moindre écart plutôt que de risquer de
// perdre l'outillage d'un autre programme (ex. Vibe Island).
function diffFingerprints(beforeFp, afterFp) {
  const beforeSet = new Set(beforeFp);
  const afterSet = new Set(afterFp);
  return {
    disparu: beforeFp.filter((e) => !afterSet.has(e)),
    apparu: afterFp.filter((e) => !beforeSet.has(e)),
  };
}

const fpBefore = foreignFingerprint(before);
const fpAfter = foreignFingerprint(after);
if (JSON.stringify(fpBefore) !== JSON.stringify(fpAfter)) {
  const { disparu, apparu } = diffFingerprints(fpBefore, fpAfter);
  fail(
    [
      `Refus d'écrire : l'empreinte de ce qui n'est pas à nous a changé pendant la transformation.`,
      disparu.length > 0 ? `Disparu (${disparu.length}) :\n  ${disparu.join('\n  ')}` : null,
      apparu.length > 0 ? `Apparu (${apparu.length}) :\n  ${apparu.join('\n  ')}` : null,
      `Rien n'a été écrit.`,
    ]
      .filter((line) => line !== null)
      .join('\n'),
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

// Copie le bridge avant d'écrire settings.json : si la copie échoue (source
// disparue entre la vérification et ici, disque plein…), les hooks référencés
// dans settings.json ne doivent jamais être posés avant que la cible existe.
// copyFileSync écrase une copie précédente sans se plaindre : une réinstallation
// reste idempotente.
if (!uninstall) {
  mkdirSync(dirname(bridgeTarget), { recursive: true });
  copyFileSync(bridgeSource, bridgeTarget);
  chmodSync(bridgeTarget, 0o755);
  console.log(`Bridge copié : ${bridgeSource} → ${bridgeTarget}`);
}

// Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau,
// jamais un fichier à moitié écrit.
const serialized = JSON.stringify(after, null, style.indent);
const tmp = join(dirname(SETTINGS), `.tmp-settings-${process.pid}`);
writeFileSync(tmp, style.newline ? `${serialized}\n` : serialized, 'utf8');
renameSync(tmp, SETTINGS);

console.log(`Entrées koh-claude : ${countKohEntries(before)} → ${countKohEntries(after)}`);
