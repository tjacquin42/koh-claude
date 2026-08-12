import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spoolDirs, type SpoolDirs } from '../src/paths';
import { ensureDirs, readSessions } from '../src/spool/persist';
import { drain } from '../src/spool/watcher';
import { countKohEntries } from '../src/hooks/installer';
import { HOOK_EVENTS } from '../src/events/types';

// Bout en bout : installation des hooks sur une configuration bidon, exécution du
// vrai bridge pour trois événements d'une même session, réduction par le chemin de
// production, puis désinstallation. Tout se joue sous un HOME et un KOH_CLAUDE_HOME
// détournés vers un dossier jetable : rien ne touche ~/.claude/settings.json ni
// ~/.koh-claude/ réels. Déterministe et isolé par variables d'environnement — au
// même titre que test/bridge.test.ts et test/installer.test.ts, ce test a sa place
// dans la suite plutôt que dans un script à part : aucune dépendance à un état de
// l'éditeur ou à une temporisation qui le rendrait fragile en CI.
const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, 'scripts/install-hooks.cjs');
const BRIDGE = join(REPO_ROOT, 'bin/koh-claude-bridge');
const SESSION_ID = 'e2e-session-1';

const bidonSettings = {
  model: 'opus',
  hooks: {
    PermissionRequest: [
      { matcher: '*', hooks: [{ type: 'command', command: '/vibe/bridge --source claude', timeout: 86400 }] },
    ],
  },
};

let fakeHome: string;
let kohHome: string;
let dirs: SpoolDirs;
let projectDir: string;
let settingsPath: string;

function runInstaller(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: fakeHome, KOH_CLAUDE_HOME: kohHome },
    encoding: 'utf8',
  });
}

function runBridge(event: string, payload: Record<string, unknown>): void {
  const out = execFileSync(BRIDGE, [event], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HOME: fakeHome,
      KOH_CLAUDE_HOME: kohHome,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERM_PROGRAM: 'iTerm.app',
    },
    encoding: 'utf8',
  });
  expect(out).toBe('');
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'koh-e2e-home-'));
  kohHome = join(fakeHome, '.koh-claude');
  dirs = spoolDirs(kohHome);
  projectDir = join(fakeHome, 'mon-projet');
  settingsPath = join(fakeHome, '.claude', 'settings.json');

  // Simule ce que fait l'extension à l'activation : le spool existe déjà avant
  // que les hooks ne soient installés.
  await ensureDirs(dirs);

  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(bidonSettings, null, 2)}\n`, 'utf8');
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('bout en bout : installer → bridge → réduction → désinstaller', () => {
  it('installe une copie stable et exécutable du bridge, référencée par les 8 hooks', () => {
    runInstaller();

    const bridgeTarget = join(kohHome, 'bin', 'koh-claude-bridge');
    const stat = statSync(bridgeTarget);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0); // au moins un bit d'exécution posé

    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof bidonSettings & {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    };
    expect(countKohEntries(after)).toBe(8);

    for (const event of HOOK_EVENTS) {
      const commands = after.hooks[event]?.flatMap((m) => m.hooks.map((h) => h.command)) ?? [];
      expect(commands).toContain(`/bin/sh -c '[ -x "${bridgeTarget}" ] && "${bridgeTarget}" ${event}; exit 0'`);
    }

    // L'entrée étrangère préexistante n'a pas bougé.
    expect(after.hooks.PermissionRequest.flatMap((m) => m.hooks.map((h) => h.command))).toContain(
      '/vibe/bridge --source claude',
    );
  });

  it('réinstalle sans se plaindre et écrase la copie du bridge en place', () => {
    runInstaller();
    const bridgeTarget = join(kohHome, 'bin', 'koh-claude-bridge');
    const firstRun = statSync(bridgeTarget).mtimeMs;

    // Une deuxième copie, même contenu, un peu plus tard : mtime doit avancer,
    // preuve que copyFileSync a bien réécrit le fichier plutôt que de le laisser
    // en place ou d'échouer parce qu'il existe déjà.
    const second = runInstaller();
    expect(second).not.toMatch(/error|erreur/i);

    const stat = statSync(bridgeTarget);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
    expect(stat.mtimeMs).toBeGreaterThanOrEqual(firstRun);
    expect(countKohEntries(JSON.parse(readFileSync(settingsPath, 'utf8')))).toBe(8);
  });

  it('remplit le spool via le vrai bridge, puis réduit un statut, un projet et une action courante cohérents', async () => {
    runInstaller();

    runBridge('SessionStart', {
      session_id: SESSION_ID,
      cwd: projectDir,
      transcript_path: join(fakeHome, 'transcript.jsonl'),
    });
    runBridge('UserPromptSubmit', { session_id: SESSION_ID, cwd: projectDir });
    runBridge('PreToolUse', {
      session_id: SESSION_ID,
      cwd: projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    });

    const dropped = readdirSync(dirs.events).filter((f) => f.endsWith('.json'));
    expect(dropped).toHaveLength(3);

    const res = await drain(dirs); // chemin de production : le même que SpoolWatcher.tick()
    expect(res.applied).toBe(3);
    expect(res.rejected).toBe(0);

    const sessions = await readSessions(dirs);
    const session = sessions.get(SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.status).toBe('running');
    expect(session?.project).toBe('mon-projet');
    expect(session?.currentAction).toEqual({ tool: 'Bash', target: 'pnpm test' });
  });

  it('désinstalle et rend la configuration bidon strictement identique à son état de départ', () => {
    runInstaller();
    expect(countKohEntries(JSON.parse(readFileSync(settingsPath, 'utf8')))).toBe(8);

    runInstaller('--uninstall');

    const back = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(countKohEntries(back)).toBe(0);
    expect(back).toEqual(bidonSettings);
  });
});
