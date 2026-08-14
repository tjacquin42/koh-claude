#!/usr/bin/env node
// Écrit build-info.json à la racine du paquet, lu par la vue pour afficher ce
// qui tourne réellement.
//
// La version vient de package.json, qui fait foi (CLAUDE.md) : il est bumpé dans
// la PR de promotion, donc AVANT le merge, et suit la branche courante.
//
// Elle venait autrefois de `git describe`, et c'était un piège silencieux : le
// tag est posé sur le commit de merge de la PR vers `main`, que `dev` ne contient
// pas. Tout paquet construit depuis `dev` annonçait donc la version précédente —
// ou « sans version » tant qu'aucun tag n'avait été récupéré en local. Un
// manifeste ne peut pas manquer de la sorte : il est dans l'arbre.
//
// Le commit accompagne la version parce que la version seule ne distingue pas
// deux paquets successifs : elle ne bouge qu'à la promotion, alors qu'un build
// est installé à chaque correctif. Sans lui, « j'ai rechargé et c'est pareil »
// reste une question sans réponse.
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// Un manifeste illisible ou sans numéro valable n'invente pas de version : la vue
// dit « sans version », ce qui est vrai, plutôt que d'afficher un numéro douteux.
function released() {
  let version;
  try {
    ({ version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  } catch {
    return {};
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return {};
  const tag = `v${version}`;
  // « +7 » = sept commits depuis la promotion qui a posé ce numéro. Le compte
  // demande le tag correspondant ; il peut manquer (dépôt fraîchement cloné sans
  // ses tags, build hors dépôt). L'écart est alors omis, jamais deviné — la
  // version reste juste, elle perd seulement sa précision.
  try {
    const ahead = Number(git(['rev-list', '--count', `${tag}..HEAD`]).trim());
    return Number.isFinite(ahead) ? { version: tag, ahead } : { version: tag };
  } catch {
    return { version: tag };
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

// Hors dépôt git, le commit et le marqueur manquent — pas la version, qui est
// dans le manifeste. Le fichier est donc écrit quand même : un paquet reconstruit
// ailleurs affiche « v1.2.0 » plutôt que rien du tout.
function build() {
  try {
    const commit = git(['rev-parse', '--short=7', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain'])
      .split('\n')
      .filter((l) => l.length > 3)
      .map(changedPath)
      .some((p) => PACKAGED.test(p));
    return { commit, dirty };
  } catch {
    return {};
  }
}

writeFileSync(join(root, 'build-info.json'), JSON.stringify({ ...released(), ...build() }) + '\n', 'utf8');
