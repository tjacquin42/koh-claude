#!/usr/bin/env bash
# Pose la version d'une PR qui vient d'atterrir sur main.
#   scripts/bump-version.sh [major|minor|patch] [numéro-de-PR]
#
# Sans argument, le niveau est lu dans le corps de la PR (ligne « Version: minor »)
# et la PR est celle dont le merge est en tête de origin/main.
# Crée le tag, la Release GitHub, l'entrée de CHANGELOG, le label et la milestone.
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
git fetch --quiet origin main --tags

PR="${2:-}"
if [ -z "$PR" ]; then
  PR=$(gh pr list --repo "$REPO" --state merged --base main --limit 1 --json number -q '.[0].number')
  [ -z "$PR" ] && { echo "Aucune PR mergée sur main trouvée." >&2; exit 1; }
fi

LEVEL="${1:-}"
if [ -z "$LEVEL" ]; then
  LEVEL=$(gh pr view "$PR" --repo "$REPO" --json body -q .body \
          | grep -iEo '^[[:space:]]*Version:[[:space:]]*(major|minor|patch)' | head -1 \
          | grep -iEo '(major|minor|patch)' | tr 'A-Z' 'a-z' || true)
fi
case "$LEVEL" in
  major|minor|patch) ;;
  *) echo "Niveau absent ou invalide. Ajoute « Version: minor » au corps de la PR #$PR, ou passe-le en argument." >&2; exit 1 ;;
esac

LAST=$(git tag -l 'v[0-9]*' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
LAST="${LAST:-0.0.0}"
IFS=. read -r MA MI PA <<< "$LAST"
case "$LEVEL" in
  major) MA=$((MA+1)); MI=0; PA=0 ;;
  minor) MI=$((MI+1)); PA=0 ;;
  patch) PA=$((PA+1)) ;;
esac
V="$MA.$MI.$PA"; TAG="v$V"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG existe déjà." >&2; exit 1; }

SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit -q .mergeCommit.oid)
TITLE=$(gh pr view "$PR" --repo "$REPO" --json title -q .title)
DATE=$(date +%Y-%m-%d)
URL="https://github.com/$REPO"

NOTES=$(printf '**[#%s](%s/pull/%s)** — %s\n\n`%s` · %s' "$PR" "$URL" "$PR" "$TITLE" "$LEVEL" "$DATE")
gh release create "$TAG" --repo "$REPO" --target "$SHA" --title "$V — $TITLE" --notes "$NOTES"

# CHANGELOG : insertion sous l'en-tête
ENTRY=$(printf '## [%s](%s/releases/tag/%s) — %s\n\n`%s` · [#%s](%s/pull/%s) — %s\n' \
        "$V" "$URL" "$TAG" "$DATE" "$LEVEL" "$PR" "$URL" "$PR" "$TITLE")
if [ -f CHANGELOG.md ]; then
  awk -v e="$ENTRY" 'BEGIN{done=0} /^## /&&!done{print e"\n";done=1} {print} END{if(!done)print "\n"e}' \
      CHANGELOG.md > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md
else
  printf '# Changelog\n\n%s\n' "$ENTRY" > CHANGELOG.md
fi

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
echo "Pense à commiter CHANGELOG.md"
