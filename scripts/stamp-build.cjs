#!/usr/bin/env node
// Écrit build-info.json à la racine du paquet, lu par la vue pour afficher ce
// qui tourne réellement.
//
// La version ne vient PAS de package.json : la convention du projet (CLAUDE.md)
// dit qu'il reste à sa valeur d'origine et ne fait pas foi. La source est le
// tag posé par la livraison — donc `git describe`, et rien d'autre.
//
// Le commit accompagne la version parce que la version seule ne distingue pas
// deux paquets successifs : elle ne bouge qu'à la fusion vers main, alors qu'un
// build est installé à chaque correctif. Sans lui, « j'ai rechargé et c'est
// pareil » reste une question sans réponse.
//
// Hors dépôt git (paquet reconstruit ailleurs), on n'invente rien : le fichier
// n'est pas écrit et la vue le dit.
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// Rien de tout ceci n'existe avant la première livraison : un dépôt sans tag
// n'est pas une anomalie, et l'absence de version doit s'afficher comme telle
// plutôt que d'emprunter un numéro à package.json.
function released() {
  try {
    const version = git(['describe', '--tags', '--abbrev=0']).trim();
    const ahead = Number(git(['rev-list', '--count', `${version}..HEAD`]).trim());
    return { version, ahead: Number.isFinite(ahead) ? ahead : 0 };
  } catch {
    return {};
  }
}

// L'étoile ne veut pas dire « le dépôt est sale », mais « ce paquet ne
// correspond pas à ce commit ». Seuls comptent donc les chemins dont le contenu
// finit dans le .vsix (voir .vscodeignore) : un .vscode/ local ou un test
// modifié ne changent rien à ce qui tourne, et s'ils allumaient le marqueur en
// permanence il ne voudrait plus rien dire.
const PACKAGED = /^(src|resources|bin)\/|^(package\.json|tsconfig\.json|\.vscodeignore)$/;

function changedPath(line) {
  // Format porcelain : deux colonnes d'état, une espace, puis le chemin —
  // « old -> new » pour un renommage, dont seule la destination existe.
  const path = line.slice(3);
  const arrow = path.indexOf(' -> ');
  return arrow === -1 ? path : path.slice(arrow + 4);
}

try {
  const commit = git(['rev-parse', '--short=7', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain'])
    .split('\n')
    .filter((l) => l.length > 3)
    .map(changedPath)
    .some((p) => PACKAGED.test(p));
  writeFileSync(join(root, 'build-info.json'), JSON.stringify({ ...released(), commit, dirty }) + '\n', 'utf8');
} catch {
  process.exit(0);
}
