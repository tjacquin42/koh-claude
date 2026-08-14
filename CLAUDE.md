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

Une fois la PR mergée sur `main`, **la livraison s'en charge toute seule** : le job
`version` de `.github/workflows/cd.yml` pose le tag, la Release GitHub, l'entrée de
`CHANGELOG.md`, le label `vX.Y.Z` et la milestone.

Si la ligne `Version:` manque, **un `patch` est posé par défaut** : une livraison sans
version est un trou définitif dans l'historique, un patch de trop se rattrape. La CI
avertit sur la PR, avant le merge. Rattrapage à la main si besoin :

```bash
scripts/bump-version.sh minor 42     # niveau + numéro de PR
```

**Ne jamais poser un tag ni écrire une entrée de CHANGELOG à la main** : le script est la
seule source, sinon les quatre artefacts divergent.

La version courante se lit avec `gh release list` ou en tête de `CHANGELOG.md`.
Les `package.json` ne portent **pas** la version : ils restent à leur valeur d'origine et
ne font pas foi.

## Langue

Trois régimes, à ne pas mélanger.

**Le code est en anglais.** Tout ce qu'un contributeur extérieur lit pour comprendre le
dépôt : noms de symboles, commentaires, messages de commit, titres et corps de PR, messages
de merge, noms de branches, libellés d'issues. Le dépôt est public — un contributeur qui ne
parle pas français doit pouvoir s'y retrouver seul.

**Les fichiers d'information sont bilingues.** `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
existent en anglais (fichier principal) et en français (suffixe `.fr.md`). L'anglais fait
foi ; le français le suit. Les deux versions se modifient dans le même commit — une
traduction en retard est pire qu'absente, parce qu'elle affirme quelque chose de faux.

**Le texte affiché suit l'utilisateur.** Aucune chaîne visible n'est écrite en dur dans une
langue : les libellés contribués passent par `package.nls.json`, ceux du code par
`vscode.l10n.t()`. L'anglais est la valeur par défaut — donc la chaîne écrite dans le source —
et `l10n/bundle.l10n.fr.json` porte le français. Une langue sans traduction retombe sur
l'anglais, jamais sur une chaîne vide.

Exception assumée : **ce fichier**. `CLAUDE.md` s'adresse à l'outillage du projet et à son
mainteneur, pas à ses contributeurs. Il reste en français et n'a pas de jumeau anglais.
