# koh-vibe

Extension VSCode : tableau de bord des sessions Claude Code — tous projets et toutes
fenêtres, avec statut, action en cours et conso par session.

*Koh* : « île » en thaï. Inspiré de [open-vibe-island](https://github.com/Octane0411/open-vibe-island),
qui fait la même chose dans l'encoche du Mac. Aucun code n'en est repris.

**Architecture** : des hooks Claude Code déposent chaque événement dans un spool de
fichiers (`~/.koh-vibe/`) via un bridge shell qui n'interprète rien ; chaque fenêtre
VSCode observe ce spool, réduit les événements en état, et l'affiche dans la barre
latérale et la barre d'état.

**Installation** : VSIX local (`pnpm package`) — pas de publication sur le marketplace.
