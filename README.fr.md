# Koh-Vibe

*[English version](README.md)*

Toutes vos sessions Claude Code dans une seule vue : celles de tous les projets, de toutes
les fenêtres et de tous les éditeurs de la machine — avec leur statut, ce qu'elles sont en
train de faire, et votre consommation.

*Koh* : « île » en thaï. Inspiré de [open-vibe-island](https://github.com/Octane0411/open-vibe-island),
qui fait la même chose dans l'encoche du Mac. Aucun code n'en est repris.

**macOS uniquement.** Les carillons passent par `afplay`, le jeton de consommation est lu dans
le trousseau du système, et les ponts de hooks sont des scripts zsh.

## Ce que ça affiche

- **Les sessions vivantes**, triées par ce qui réclame votre attention : celles qui vous
  attendent d'abord, puis celles qui travaillent, puis celles qui viennent de finir.
- **Une pastille de statut** par session — même glyphe, cinq couleurs — et, à côté, le projet,
  la branche et l'outil en cours d'exécution.
- **Fermé récemment**, les cinq conversations terminées le plus récemment, gardées sous les
  sessions vivantes pour qu'une session qu'on vient de quitter ne disparaisse pas d'un coup.
- **Votre consommation** sur cinq heures et sept jours, avec l'échéance de remise à zéro.
- **Un clic** sur une session ouvre ou reprend sa fenêtre, où qu'elle soit — y compris une
  session fermée.

## Installation

L'extension n'est pas publiée sur la place de marché : elle s'installe depuis un paquet
construit en local.

```bash
pnpm install
pnpm package
code --install-extension koh-vibe-0.1.0.vsix --force
```

`pnpm package` compile avant d'empaqueter — le `.vsix` produit contient donc toujours le code
que vous venez d'écrire.

Les forks de VSCode exposent la même commande sous un autre nom (leur binaire CLI, souvent
disponible depuis leur palette via *Install 'code' command in PATH*). Le même `.vsix` s'y
installe sans changement.

**Quittez complètement l'éditeur après l'installation** — pas un simple rechargement de
fenêtre. Les icônes et les vues sont lues au démarrage.

### Poser les hooks

Rien ne s'affiche tant que Claude Code ne dépose pas ses événements. Ouvrez la vue Koh-Vibe
et cliquez sur *Hooks non installés*, ou lancez **Koh-Vibe: Installer les hooks** depuis la
palette.

Le script ajoute huit hooks à `~/.claude/settings.json`, **sauvegarde le fichier avant d'y
toucher**, et refuse d'écrire si son empreinte a changé entre-temps. Les hooks et la
statusline que vous aviez déjà sont préservés : Koh-Vibe s'enchaîne au bout, il ne remplace
rien. **Koh-Vibe: Désinstaller les hooks** défait exactement cela.

## S'en servir

**Ranger.** Créez des dossiers, glissez-y des sessions, donnez-leur une couleur. L'ordre à
l'intérieur d'un dossier se fixe à la main et ne bouge plus : une session ouverte plus tard
se pose à la fin sans bousculer ce qui a été placé. Les dossiers eux-mêmes se glissent de la
même façon — déposez-en un sur un autre pour le placer devant, ou sur *Sans dossier* pour
l'envoyer à la fin.

**Sonner.** Un carillon quand une session se met à vous attendre, un autre quand elle vient
de finir. Trois niveaux, du plus précis au plus général : le son d'une conversation l'emporte
sur celui de son dossier, qui l'emporte sur le réglage global. « Aucun » est un choix de
silence, pas une absence de choix — il ne remonte donc pas d'un cran.

Les sons de macOS servent de base. Koh-Vibe propose d'y ajouter une bibliothèque de cent sons
d'interface courts ([Kenney](https://kenney.nl/assets/interface-sounds), CC0), téléchargée une
seule fois et rangée chez lui — jamais dans `~/Library/Sounds`, dont la liste sert aussi au
panneau Son du système. La ligne *Bibliothèque de sons* des réglages l'installe et la retire.

Dans la liste de choix, les flèches font entendre chaque son ; **→** rejoue le son survolé.

**Retirer.** Clic droit sur une session → *Retirer de la liste*. Rien n'est arrêté : Claude
Code tourne dans son terminal, et une session encore vivante réapparaîtra à son prochain
événement.

**Rouvrir.** Une conversation qui vient de se terminer ne disparaît pas : elle passe dans
*Fermé récemment*, sous les sessions vivantes, tant que quatre autres ne l'ont pas encore
poussée dehors. Un clic la ramène — dans l'onglet d'éditeur où elle tournait, ou dans un
terminal neuf posé sur son dossier, selon d'où elle venait.

## Où vivent les données

Tout tient dans `~/.koh-vibe/` :

| | |
|---|---|
| `bin/` | le pont et l'enrobage de statusline, copiés à l'installation des hooks |
| `events/` | le spool : un fichier par événement, consommé puis effacé |
| `events/rejected/` | ce qui n'a pas pu être lu, gardé plutôt que jeté |
| `sessions/` | l'état réduit, un fichier par session |
| `requests/` | les demandes de mise au premier plan et de réouverture, d'une fenêtre à l'autre |
| `backups/` | les copies de `settings.json` prises avant chaque pose de hooks |
| `groups.json` | les dossiers, leurs couleurs, l'ordre choisi et les sons |
| `closed.json` | les cinq conversations fermées le plus récemment |
| `settings.json` | les sons globaux et le volume |
| `usage.json` | le dernier relevé de consommation, mis en cache |
| `status.json` | le dernier instantané de la statusline |
| `sounds/` | la bibliothèque, si vous l'avez installée |

Ces fichiers sont **partagés entre toutes les fenêtres et tous les éditeurs** de la machine :
un dossier créé d'un côté apparaît de l'autre, et un son choisi une fois vaut partout.
Désinstaller l'extension ne les efface pas ; supprimer le dossier suffit à repartir de zéro.

## Comment ça marche

Les hooks de Claude Code appellent un **pont shell** qui n'interprète rien : il recopie ce
qu'il reçoit dans le spool, n'écrit jamais sur la sortie standard, et sort toujours en
succès. Un pont qui analyserait le JSON pourrait échouer, et un hook qui échoue perturbe la
session qu'il observe — le seul comportement acceptable est de ne rien casser, quitte à
perdre un événement.

Chaque fenêtre surveille le spool de son côté, réduit les événements en état, et l'affiche.
Aucun verrou : les fichiers partagés sont fusionnés à trois voies (l'état lu, le nôtre, et
le plus frais relu juste avant d'écrire), pour que deux fenêtres qui rangent en même temps ne
s'effacent pas l'une l'autre.

La consommation vient de l'API d'Anthropic, interrogée au plus une fois toutes les cinq
minutes et mise en cache dans un fichier partagé — sinon chaque fenêtre irait chercher de son
côté exactement la même chose. Le jeton OAuth est lu dans le trousseau du système, jamais
journalisé ni écrit sur le disque.

## Contribuer

Les contributions extérieures sont bienvenues — voir [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md).

## Développement

```bash
pnpm install
pnpm build       # compile vers out/, et date le paquet depuis le dernier tag
pnpm test        # compile, puis lance 501 tests sans hôte d'extensions
pnpm test:watch  # les mêmes tests, sans recompiler à chaque fois
pnpm typecheck   # types de src ET de test
pnpm package     # produit le .vsix
```

`pnpm test` compile d'abord, parce que le test de bout en bout lance
`scripts/install-hooks.cjs`, qui charge l'installateur compilé. Cette dépendance était
invisible : elle tenait sur une machine ayant déjà construit une fois, et tombait sur un clone
frais.

Les tests ne démarrent pas VSCode : `vscode` est résolu vers un bouchon
(`test/stubs/vscode.ts`), ce qui rend l'arbre, les commandes et le pont testables en
millisecondes. Le typeur, lui, travaille contre la vraie API — un bouchon qui divergerait de
ses signatures ne prouverait plus rien.

`scripts/make-icons.cjs` regénère les deux icônes à partir de la table de points qu'il
contient : c'est elle, la source du dessin.

Le versionnement est décrit dans [CLAUDE.md](CLAUDE.md) — une PR mergée sur `main` vaut une
version, et la livraison la pose toute seule.

## Licence

[MIT](LICENSE).
