#!/usr/bin/env bash
# Pose le prochain numéro de version dans package.json.
#   scripts/set-version.sh <major|minor|patch>
#
# À lancer sur la branche de promotion, AVANT d'ouvrir la PR vers main — c'est
# la seule fenêtre où le numéro peut encore atteindre le dépôt. `main` est
# protégée et le jeton d'Actions n'a pas de dérogation : la livraison ne peut
# rien y pousser, l'entrée de CHANGELOG en fait déjà les frais. Un bump posé
# après le merge n'arriverait donc jamais dans le fichier.
#
# Le numéro se déduit de package.json lui-même, jamais des tags : c'est
# `package.json` qui fait foi (CLAUDE.md), et lui seul suit la branche courante.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/package.json"

LEVEL="${1:-}"
case "$LEVEL" in
  major|minor|patch) ;;
  *) echo "Usage: $(basename "$0") <major|minor|patch>" >&2; exit 1 ;;
esac

CURRENT=$(node -p "require('$MANIFEST').version")
# Un numéro qu'on ne sait pas lire n'est pas incrémenté au jugé : le suivant
# serait faux, et un numéro faux est pire qu'un numéro absent.
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "Version « $CURRENT » illisible dans package.json — attendu X.Y.Z." >&2; exit 1; }

IFS=. read -r MA MI PA <<< "$CURRENT"
case "$LEVEL" in
  major) MA=$((MA+1)); MI=0; PA=0 ;;
  minor) MI=$((MI+1)); PA=0 ;;
  patch) PA=$((PA+1)) ;;
esac
NEXT="$MA.$MI.$PA"

# Substitution TEXTUELLE, jamais JSON.parse + stringify : le manifeste tient ses
# tableaux de menus sur une ligne chacun, et un reformatage complet noierait le
# bump dans un diff de deux cents lignes.
node - "$MANIFEST" "$NEXT" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, next] = process.argv.slice(2);
const source = readFileSync(file, 'utf8');
const out = source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
if (out === source) {
  console.error(`Aucun champ « version » remplacé dans ${file}.`);
  process.exit(1);
}
writeFileSync(file, out);
NODE

echo "package.json : $CURRENT → $NEXT ($LEVEL)"
echo "Commit ce fichier, puis ouvre la PR vers main avec « Version: $LEVEL » dans son corps."
