#!/bin/bash
# Capture de vrais payloads de hooks sans toucher à la configuration globale.
# Tout se passe dans un dossier jetable avec son propre .claude/settings.json.
set -euo pipefail
BRIDGE="$PWD/bin/koh-claude-bridge"
WORK="$(mktemp -d)"
export KOH_CLAUDE_HOME="$WORK/spool"
mkdir -p "$WORK/.claude" "$KOH_CLAUDE_HOME/events"
echo "Bac à sable : $WORK"

python3 - "$WORK/.claude/settings.json" "$BRIDGE" <<'PYEOF'
import json, sys
out, bridge = sys.argv[1], sys.argv[2]
events = ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse",
          "PermissionRequest","Notification","Stop","SessionEnd"]
hooks = {e: [{"matcher": "*", "hooks": [{"type": "command",
        "command": f"/bin/sh -c '[ -x \"{bridge}\" ] && \"{bridge}\" {e}; exit 0'"}]}]
        for e in events}
json.dump({"hooks": hooks}, open(out, "w"), indent=2)
PYEOF

printf 'Bonjour.\n' > "$WORK/NOTES.md"
cd "$WORK"
# Une session headless qui appelle réellement un outil : consulter `claude --help`
# pour les drapeaux exacts permettant l'exécution sans invite interactive.
claude -p "Lis le fichier NOTES.md et réponds uniquement par son premier mot."

echo
echo "Payloads capturés :"
ls -1 "$KOH_CLAUDE_HOME/events/"

echo
echo "PermissionRequest et Notification n'apparaîtront pas : ils exigent une vraie"
echo "interaction. Ils sont capturés séparément, à la main."
