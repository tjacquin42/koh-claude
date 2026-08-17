# Contribuer

*[English version](CONTRIBUTING.md)*

Les contributions extérieures sont bienvenues. Cette page dit ce que le dépôt attend, pour
qu'une PR ne reparte pas sur un point que personne ne vous avait annoncé.

## Avant d'écrire du code

Ouvrez une issue d'abord, pour tout ce qui dépasse une correction. L'extension a un périmètre
volontairement étroit — observer les sessions Claude Code — et le moyen le plus sûr de faire
refuser un travail est de l'élargir sans en discuter.

Pour un bug, dites quel éditeur, quelle version de macOS, et ce que contient
`~/.koh-vibe/events/` au moment du problème. **Ne collez jamais un payload de hook tel quel** :
il porte des chemins absolus, des prompts, et parfois des secrets. Dites ce qu'il y a dedans,
pas ce qu'il dit.

## Le flux

Partez de `dev`, ouvrez votre PR vers `dev`. `main` ne reçoit que `dev`, et une PR mergée sur
`main` vaut une version livrée.

```bash
git switch -c fix/ce-que-vous-corrigez dev
```

Avant de pousser :

```bash
pnpm typecheck   # src et test
pnpm test
pnpm package     # prouve que l'extension s'empaquette encore
```

La CI lance ces trois commandes sur macOS, seule plateforme que l'extension sait servir. Elle
ne lit aucun secret : elle tourne donc sur les PR venues d'un fork comme sur les autres.

Pour essayer votre build pour de vrai, depuis le terminal intégré de l'éditeur où vous la
voulez :

```bash
scripts/install-local.sh    # puis : Developer: Reload Window
```

Il empaquette, puis installe dans **cet** éditeur-là plutôt que dans celui qui détient `code`
dans votre PATH — Cursor livre son propre binaire nommé `code`, et certains éditeurs n'en
posent aucun. Quand le terminal n'appartient à aucun éditeur, il refuse au lieu de deviner.

## Ce que la revue regarde

**Les tests viennent avec le changement, pas après.** Un comportement sans test est un
comportement que personne n'osera toucher plus tard. Un test qui passe pour la mauvaise raison
est pire qu'aucun : vérifiez qu'il échoue quand vous annulez le correctif.

**Les commentaires disent le pourquoi, jamais le quoi.** Le code dit déjà ce qu'il fait. Ce
qu'il ne peut pas dire, c'est le piège que vous avez évité — et c'est ça qu'il faut au suivant.

**Pas de `any`.** Le typeur est strict, variables inutilisées comprises. Si un type résiste
vraiment, un cast étroit commenté vaut mieux que d'assouplir tout le fichier.

**Rien de personnel dans le dépôt.** Aucun chemin absolu de votre machine, aucun nom de client,
aucun identifiant de session réel. Les fixtures utilisent `/Users/dev/projet`.

## Langue

**Le code est en anglais** : noms de symboles, commentaires, messages de commit, titres et
corps de PR, noms de branches, libellés d'issues.

**Les fichiers d'information sont bilingues** : `README.md` et `CONTRIBUTING.md` ont un jumeau
`.fr.md`. L'anglais fait foi, le français le suit ; les deux changent dans le même commit.
`CHANGELOG.md` est en anglais seul — il est engendré à partir des titres de PR, qui sont en
anglais.

**Le texte affiché suit l'utilisateur.** Aucune chaîne visible n'est écrite en dur dans une
langue : les libellés contribués passent par `package.nls.json`, ceux du code par
`vscode.l10n.t()`. La chaîne écrite dans le source est l'anglaise ;
`l10n/bundle.l10n.fr.json` porte le français.

Ajouter une langue tient en un fichier — `l10n/bundle.l10n.<lang>.json` — plus
`package.nls.<lang>.json` pour les libellés contribués. Une traduction manquante retombe sur
l'anglais et non sur une chaîne vide : un bundle partiel est donc parfaitement recevable.

## Le merge

Le propriétaire du dépôt est le seul relecteur, et `main` est protégée : pas de push direct,
une PR avec l'approbation du code owner, et une CI verte.

Rien ici ne promet qu'une contribution sera mergée. C'est un projet personnel ; le périmètre
reste étroit à dessein.
