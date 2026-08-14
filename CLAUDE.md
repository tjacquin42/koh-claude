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
