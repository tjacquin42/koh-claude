#!/usr/bin/env node
// Installe ou désinstalle les hooks koh-claude dans ~/.claude/settings.json.
//   node scripts/install-hooks.cjs --bridge <chemin>
//   node scripts/install-hooks.cjs --uninstall
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { countKohEntries, installHooks, uninstallHooks } = require('../out/hooks/installer.js');

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const BACKUPS = join(homedir(), '.koh-claude', 'backups');
const uninstall = process.argv.includes('--uninstall');
const bridgeArg = process.argv.indexOf('--bridge');
const bridge =
  bridgeArg > -1 ? process.argv[bridgeArg + 1] : join(process.cwd(), 'bin/koh-claude-bridge');

const before = JSON.parse(readFileSync(SETTINGS, 'utf8'));
mkdirSync(BACKUPS, { recursive: true });
const backup = join(BACKUPS, `settings-${Date.now()}.json`);
copyFileSync(SETTINGS, backup);

const after = uninstall ? uninstallHooks(before) : installHooks(before, bridge);
writeFileSync(SETTINGS, `${JSON.stringify(after, null, 2)}\n`, 'utf8');

console.log(`Sauvegarde : ${backup}`);
console.log(`Entrées koh-claude : ${countKohEntries(before)} → ${countKohEntries(after)}`);
