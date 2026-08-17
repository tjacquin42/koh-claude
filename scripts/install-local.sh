#!/usr/bin/env bash
# Builds Koh-Vibe and installs it into the editor this terminal belongs to.
#
#   scripts/install-local.sh
#
# Run it from the integrated terminal of the editor you want to install into.
#
# The whole point of this script is that it never guesses which editor that is.
# `code` on the PATH belongs to Visual Studio Code; Cursor ships a binary also
# called `code` inside its own bundle; Antigravity's command is called
# `antigravity-ide` and is not on the PATH at all. A script falling back to
# `code` therefore does not fail when it cannot tell — it silently installs
# into a different editor than the one you are looking at.
#
# So the editor is read out of what its integrated terminal exports, and the
# proof that we found one is that the application carries a `product.json`:
# that file is what makes it a VSCode-family editor, and it is also what names
# its command. Nothing else is trusted, and nothing is attempted without it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

die() { printf '%s\n' "$@" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required."
command -v pnpm >/dev/null 2>&1 || die "pnpm is required — see CONTRIBUTING.md."

# Where the running editor is installed, from the environment only.
#
# Deliberately NOT gated on TERM_PROGRAM: inside tmux, or any nested shell that
# rewrites it, the terminal still belongs to the editor and the variables below
# still hold. Whether we really found an editor is settled further down, by the
# presence of its product.json, not by a display variable.
app_root() {
  # VSCODE_GIT_ASKPASS_NODE is the extension host's own executable, exported
  # into every integrated terminal by the built-in git extension. On macOS it
  # lives inside the bundle's Frameworks directory; elsewhere it sits directly
  # in the install root.
  local host="${VSCODE_GIT_ASKPASS_NODE:-}"
  if [ -n "$host" ]; then
    case "$host" in
      */Contents/Frameworks/*) printf '%s\n' "${host%%/Contents/Frameworks/*}"; return ;;
      *) (cd "$(dirname "$host")" && pwd); return ;;
    esac
  fi
  # macOS fallback, for a terminal whose git extension is disabled: every child
  # process of an application inherits its bundle identifier.
  if [ -n "${__CFBundleIdentifier:-}" ] && command -v mdfind >/dev/null 2>&1; then
    mdfind "kMDItemCFBundleIdentifier == '${__CFBundleIdentifier}'" 2>/dev/null | head -1
  fi
}

NOT_AN_EDITOR=(
  "This terminal does not belong to a VSCode-family editor."
  "Open the integrated terminal of the editor you want to install into, and run it from there."
  "Otherwise install by hand: <that editor's command> --install-extension <file>.vsix --force"
)

APP=$(app_root)
[ -n "$APP" ] && [ -e "$APP" ] || die "${NOT_AN_EDITOR[@]}"

# The editor's resources directory. Reading the command name from product.json
# rather than looking for a familiar binary is what keeps Cursor's bundled
# `code` — and every other editor's — out of the way.
RESOURCES=""
for candidate in "$APP/Contents/Resources/app" "$APP/resources/app"; do
  [ -f "$candidate/product.json" ] && { RESOURCES="$candidate"; break; }
done
[ -n "$RESOURCES" ] || die "${NOT_AN_EDITOR[@]}" "" "Found \"$APP\", which carries no product.json."

COMMAND=$(node -p "require('$RESOURCES/product.json').applicationName || ''")
[ -n "$COMMAND" ] || die "\"$RESOURCES/product.json\" names no applicationName."

CLI="$RESOURCES/bin/$COMMAND"
[ -x "$CLI" ] || die "\"$CLI\" is missing or not executable."

EDITOR_NAME=$(node -p "require('$RESOURCES/product.json').nameLong || 'unknown editor'")
NAME=$(node -p "require('$ROOT/package.json').name")
VERSION=$(node -p "require('$ROOT/package.json').version")
VSIX="$ROOT/$NAME-$VERSION.vsix"

# Announced before anything is built: if the detection went wrong, you see it
# here rather than discovering it in the wrong window afterwards.
printf 'Editor  %s\n' "$EDITOR_NAME"
printf 'Command %s\n' "$CLI"
printf 'Package %s %s\n\n' "$NAME" "$VERSION"

pnpm package
[ -f "$VSIX" ] || die "Expected \"$VSIX\" after packaging, and it is not there."

"$CLI" --install-extension "$VSIX" --force

printf '\nInstalled. Reload the window to pick it up: Developer: Reload Window.\n'
