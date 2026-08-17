#!/bin/sh
# Builds Koh-Vibe and installs it into the editor this terminal belongs to.
#
#   sh install.sh
#
# Then reload the window: Developer: Reload Window.
#
# Two things this does that a plain `code --install-extension` does not.
#
# It installs into the editor you are actually looking at. `code` on the PATH
# belongs to Visual Studio Code; Cursor ships a binary of the same name inside
# its own bundle; Antigravity's command is `antigravity-ide` and is on no PATH
# at all. Falling back to `code` does not fail when it cannot tell — it quietly
# installs somewhere else. So the editor is read from what its terminal
# exports, and its `product.json` both proves it is one and names its command.
#
# And it packages under a throwaway version number. The install directory is
# named after the version, which only moves at release time, so reinstalling
# rewrites the same directory and the editor keeps serving what it already had
# — that is why an update seemed to need a full restart. A fresh number each
# time lands in a fresh directory, and a window reload is always enough.
# `package.json` is not touched: the number is passed to the packager instead.
set -eu

cd "$(dirname "$0")"

die() { printf '%s\n' "$1" >&2; exit 1; }

# Where the running editor is installed, from the environment only.
# VSCODE_GIT_ASKPASS_NODE is the extension host's own executable, exported into
# every integrated terminal. On macOS it sits inside the bundle's Frameworks
# directory; elsewhere it sits directly in the install root.
app=""
if [ -n "${VSCODE_GIT_ASKPASS_NODE:-}" ]; then
  case "$VSCODE_GIT_ASKPASS_NODE" in
    */Contents/Frameworks/*) app="${VSCODE_GIT_ASKPASS_NODE%%/Contents/Frameworks/*}" ;;
    *) app="$(cd "$(dirname "$VSCODE_GIT_ASKPASS_NODE")" && pwd)" ;;
  esac
elif [ -n "${__CFBundleIdentifier:-}" ] && command -v mdfind >/dev/null 2>&1; then
  # macOS fallback: every child process of an application inherits its bundle id.
  app=$(mdfind "kMDItemCFBundleIdentifier == '$__CFBundleIdentifier'" 2>/dev/null | head -1)
fi

resources=""
for candidate in "$app/Contents/Resources/app" "$app/resources/app"; do
  [ -f "$candidate/product.json" ] && { resources="$candidate"; break; }
done
[ -n "$resources" ] || die "This terminal does not belong to a VSCode-family editor.
Open the integrated terminal of the editor you want this installed into, and run it from there."

cli="$resources/bin/$(node -p "require('$resources/product.json').applicationName")"
[ -x "$cli" ] || die "\"$cli\" is missing or not executable."

version="$(node -p "require('./package.json').version")-dev.$(date +%s)"

printf 'Editor  %s\n' "$(node -p "require('$resources/product.json').nameLong")"
printf 'Version %s\n\n' "$version"

npx --no-install vsce package "$version" \
  --no-update-package-json --no-git-tag-version --no-dependencies \
  -o "koh-vibe-dev.vsix"

"$cli" --install-extension "koh-vibe-dev.vsix" --force
rm -f "koh-vibe-dev.vsix"

printf '\nDone. Reload the window: Developer: Reload Window.\n'
