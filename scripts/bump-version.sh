#!/usr/bin/env bash
# Pose la version d'une PR qui vient d'atterrir sur main.
#   scripts/bump-version.sh [major|minor|patch] [numéro-de-PR]
#
# Sans argument, le niveau est lu dans le corps de la PR (ligne « Version: minor »)
# et la PR est celle dont le merge est en tête de origin/main.
# Crée le tag, la Release GitHub, l'entrée de CHANGELOG, le label et la milestone.
#
# Appelé par le job « version » de la CD, dernière marche de la livraison.
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
git fetch --quiet origin main --tags

PR="${2:-}"
if [ -z "$PR" ]; then
  PR=$(gh pr list --repo "$REPO" --state merged --base main --limit 1 --json number -q '.[0].number')
  [ -z "$PR" ] && { echo "Aucune PR mergée sur main trouvée." >&2; exit 1; }
fi

# Le niveau vient du corps de la PR. Trois cas, et trois réponses distinctes :
#
#   ligne absente   → « patch », avec un avertissement. Une livraison sans version
#                     est un trou définitif dans l'historique ; un patch de trop se
#                     rattrape. C'est le cas majoritaire — sur les 30 dernières PR
#                     des six repos, la ligne manquait presque partout, et trois
#                     livraisons du 13/08 ont été perdues parce que la CD s'arrêtait ici.
#   ligne illisible → erreur. « Version: majeur » exprime une intention qu'on n'a pas
#                     su lire : deviner reviendrait à livrer un niveau faux en silence.
#   ligne valide    → ce qu'elle dit.
LEVEL="${1:-}"
if [ -z "$LEVEL" ]; then
  BODY=$(gh pr view "$PR" --repo "$REPO" --json body -q .body | tr -d '\r')
  LEVEL=$(printf '%s\n' "$BODY" \
          | grep -iE '^[[:space:]]*Version:[[:space:]]*[^[:space:]]+' | head -1 \
          | sed -E 's/^[[:space:]]*[Vv]ersion:[[:space:]]*//' \
          | awk '{print $1}' | tr 'A-Z' 'a-z' || true)
  if [ -z "$LEVEL" ]; then
    echo "::warning::La PR #$PR ne porte pas de ligne « Version: » — niveau « patch » appliqué par défaut."
    LEVEL=patch
  fi
fi
case "$LEVEL" in
  major|minor|patch) ;;
  *) echo "Niveau « $LEVEL » non reconnu dans la PR #$PR — attendu major, minor ou patch." >&2; exit 1 ;;
esac

# Le numéro ne se calcule plus ici : il est DÉJÀ dans package.json, posé par
# scripts/set-version.sh dans la PR de promotion (voir CLAUDE.md). Le déduire des
# tags était le défaut d'origine — le tag vit sur le commit de merge, que `dev`
# ne contient pas, si bien que tout paquet construit depuis `dev` annonçait la
# version précédente. Le manifeste, lui, suit la branche.
V=$(node -p "require(process.cwd() + '/package.json').version")
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "Version « $V » illisible dans package.json — attendu X.Y.Z." >&2; exit 1; }
TAG="v$V"

# Le bump peut avoir été oublié : le manifeste porte alors la version déjà livrée,
# dont le tag existe. Ce n'est pas une raison d'abandonner la livraison — une
# version manquante est un trou définitif, un numéro rattrapé se corrige. On
# applique donc le niveau annoncé au numéro courant, et on le dit fort.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  IFS=. read -r MA MI PA <<< "$V"
  case "$LEVEL" in
    major) MA=$((MA+1)); MI=0; PA=0 ;;
    minor) MI=$((MI+1)); PA=0 ;;
    patch) PA=$((PA+1)) ;;
  esac
  V="$MA.$MI.$PA"; TAG="v$V"
  echo "::warning::package.json n'a pas été bumpé avant le merge — « $LEVEL » appliqué d'office, $TAG posée. Reporte le numéro dans package.json par une PR, sinon le prochain bump repartira du mauvais chiffre."
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG existe déjà." >&2; exit 1; }
fi

SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit -q .mergeCommit.oid)
TITLE=$(gh pr view "$PR" --repo "$REPO" --json title -q .title)
DATE=$(date +%Y-%m-%d)
URL="https://github.com/$REPO"

NOTES=$(printf '**[#%s](%s/pull/%s)** — %s\n\n`%s` · %s' "$PR" "$URL" "$PR" "$TITLE" "$LEVEL" "$DATE")
gh release create "$TAG" --repo "$REPO" --target "$SHA" --title "$V — $TITLE" --notes "$NOTES"

# CHANGELOG : insertion sous l'en-tête
ENTRY=$(printf '## [%s](%s/releases/tag/%s) — %s\n\n`%s` · [#%s](%s/pull/%s) — %s\n' \
        "$V" "$URL" "$TAG" "$DATE" "$LEVEL" "$PR" "$URL" "$PR" "$TITLE")
# L'entrée passe par l'environnement, pas par « awk -v » : une valeur multiligne y est
# refusée (« awk: newline in string ») par l'awk de macOS. Et pas de « && mv » non plus —
# dans une liste « && », set -e ne tue pas le script sur l'échec de la commande de gauche,
# si bien que la première version posée pour de vrai a créé son tag et sa Release sans
# jamais écrire son entrée, sans un mot.
if [ -f CHANGELOG.md ]; then
  ENTRY="$ENTRY" awk 'BEGIN{done=0} /^## /&&!done{print ENVIRON["ENTRY"]"\n";done=1} {print} END{if(!done)print "\n"ENVIRON["ENTRY"]}' \
      CHANGELOG.md > CHANGELOG.tmp
  mv CHANGELOG.tmp CHANGELOG.md
else
  printf '# Changelog\n\n%s\n' "$ENTRY" > CHANGELOG.md
fi

# Le tag et la Release existent déjà à ce stade : si l'entrée manque, il faut le savoir
# maintenant, pas le découvrir à la version suivante.
grep -q "^## \[$V\]" CHANGELOG.md || { echo "L'entrée $V n'a pas été écrite dans CHANGELOG.md." >&2; exit 1; }

COLOR=$([ "$LEVEL" = major ] && echo B60205 || { [ "$LEVEL" = minor ] && echo 0E8A16 || echo 5319E7; })
gh label create "$TAG" --repo "$REPO" --color "$COLOR" --description "Livré dans $TAG" >/dev/null 2>&1 || true
MS=$(gh api "repos/$REPO/milestones" -f title="$TAG" -f description="Version $V — PR #$PR" -q .number 2>/dev/null \
     || gh api "repos/$REPO/milestones?state=all&per_page=100" -q ".[]|select(.title==\"$TAG\")|.number")

# La PR principale, et toutes les PR qu'elle embarque : une promotion dev → main livre
# le travail mergé sur dev entre la version précédente et celle-ci. Sans ça, ces PR
# resteraient éternellement sans version alors qu'elles sont bel et bien en ligne.
CARRIED=$(gh pr list --repo "$REPO" --state merged --limit 200 \
  --json number,baseRefName,mergedAt,labels \
  -q "[.[] | select(.baseRefName != \"main\")
          | select((.labels|map(.name)|map(startswith(\"v\"))|any) == false)
          | select(.mergedAt <= \"$(gh pr view "$PR" --repo "$REPO" --json mergedAt -q .mergedAt)\")
          | .number] | .[]")

for N in $PR $CARRIED; do
  gh pr edit "$N" --repo "$REPO" --add-label "$TAG" --remove-label "non livré" >/dev/null 2>&1 || true
  [ -n "$MS" ] && gh api -X PATCH "repos/$REPO/issues/$N" -F milestone="$MS" >/dev/null 2>&1 || true
done
[ -n "$MS" ] && gh api -X PATCH "repos/$REPO/milestones/$MS" -f state=closed >/dev/null

# Ce qui reste sur dev est signalé comme tel, pour qu'une PR sans version se lise
# « pas encore livrée » et non « oubliée ».
gh label create "non livré" --repo "$REPO" --color FBCA04 --description "Mergé sur dev, pas encore promu sur main" >/dev/null 2>&1 || true
gh pr list --repo "$REPO" --state merged --limit 200 --json number,baseRefName,labels \
  -q '.[] | select(.baseRefName != "main") | select((.labels|map(.name)|map(startswith("v"))|any) == false) | .number' \
  | while read -r N; do gh pr edit "$N" --repo "$REPO" --add-label "non livré" >/dev/null 2>&1 || true; done

echo "$TAG posée sur $SHA — $(echo $CARRIED | wc -w | tr -d ' ') PR embarquée(s) étiquetée(s)"
