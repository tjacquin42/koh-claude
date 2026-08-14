# Koh-Vibe

Extension VSCode pour un tableau de bord des sessions Claude Code.

## Versionning

**Une PR mergée sur `main` = une version, et une seule.** Le niveau se décide *à l'ouverture
de la PR* — c'est là qu'on sait ce qu'on livre — et s'écrit dans son corps, sur sa propre ligne :

```
Version: minor
```

| Niveau | Quand |
|---|---|
| `major` | Rupture pour l'utilisateur ou rupture de contrat : format du spool, contrat des hooks Claude Code, nom des fichiers d'état. |
| `minor` | Une capacité nouvelle et visible par l'utilisateur. |
| `patch` | Correction, refonte interne, doc, dépendances, contenu. **Par défaut en cas d'hésitation.** |

Les commits poussés directement sur `main` ne bumpent pas : ils sont livrés avec la PR
suivante et cités sous « Commits directs » dans son entrée de `CHANGELOG.md`.

### `package.json` fait foi

Le champ `version` de `package.json` **est** la version de l'extension. C'est lui que lisent
VSCode, le Marketplace, le nom du `.vsix` et la pastille de la vue — et c'est lui qui décide du
numéro du tag, pas l'inverse.

**Il se met à jour dans la PR de promotion, avant le merge**, jamais après :

```bash
scripts/set-version.sh minor     # écrit le numéro dans package.json, puis on commit
```

Cette contrainte n'est pas un choix de style. `main` est protégée et le jeton d'Actions n'a
pas de dérogation — GitHub réserve celle-ci aux dépôts d'organisation. **La livraison ne peut
donc rien pousser sur `main`** : c'est déjà pour cette raison que l'entrée de `CHANGELOG.md`
n'y arrive pas. Une version posée après le merge n'atteindrait jamais le fichier, et
`package.json` afficherait éternellement le numéro de la première release.

Poser le numéro avant le merge a un second effet, celui qui a motivé le changement : `dev`
porte la bonne version dès la promotion. Tant que la version se déduisait de `git describe`,
un paquet construit depuis `dev` annonçait la version *précédente* — le tag est posé sur le
commit de merge, que `dev` ne contient pas. Le bug était silencieux et permanent.

La CI de la PR vers `main` vérifie que le numéro a bougé et qu'il correspond au niveau
annoncé. Elle avertit, elle ne bloque pas.

### Ce que la livraison fait toute seule

Une fois la PR mergée, le job `version` de `.github/workflows/cd.yml` **lit le numéro dans
`package.json`** et pose le tag `vX.Y.Z`, la Release GitHub, l'entrée de `CHANGELOG.md`, le
label et la milestone.

Si `package.json` n'a pas été bumpé, la livraison ne s'arrête pas : elle applique le niveau
annoncé au numéro courant et le signale. Une livraison sans version est un trou définitif dans
l'historique ; un numéro rattrapé se corrige.

**Ne jamais poser un tag ni écrire une entrée de CHANGELOG à la main** : les scripts sont la
seule source, sinon les artefacts divergent. Rattrapage si besoin :

```bash
scripts/bump-version.sh "" 42    # niveau lu dans la PR, numéro de PR
```

La version courante se lit dans `package.json`, avec `gh release list`, ou en tête de
`CHANGELOG.md`.

## Langue

Trois régimes, à ne pas mélanger.

**Le code est en anglais.** Tout ce qu'un contributeur extérieur lit pour comprendre le
dépôt : noms de symboles, commentaires, messages de commit, titres et corps de PR, messages
de merge, noms de branches, libellés d'issues. Le dépôt est public — un contributeur qui ne
parle pas français doit pouvoir s'y retrouver seul.

**Les fichiers d'information sont bilingues.** `README.md` et `CONTRIBUTING.md` existent en
anglais (fichier principal) et en français (suffixe `.fr.md`). L'anglais fait foi ; le
français le suit. Les deux versions se modifient dans le même commit — une traduction en
retard est pire qu'absente, parce qu'elle affirme quelque chose de faux.

`CHANGELOG.md` échappe à la règle : il est engendré par `bump-version.sh` à partir des titres
de PR, qui sont en anglais. Le traduire supposerait de traduire des titres déjà livrés.

**Le texte affiché suit l'utilisateur.** Aucune chaîne visible n'est écrite en dur dans une
langue : les libellés contribués passent par `package.nls.json`, ceux du code par
`vscode.l10n.t()`. L'anglais est la valeur par défaut — donc la chaîne écrite dans le source —
et `l10n/bundle.l10n.fr.json` porte le français. Une langue sans traduction retombe sur
l'anglais, jamais sur une chaîne vide.

Exception assumée : **ce fichier**. `CLAUDE.md` s'adresse à l'outillage du projet et à son
mainteneur, pas à ses contributeurs. Il reste en français et n'a pas de jumeau anglais.
