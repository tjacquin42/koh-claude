import { describe, expect, it } from 'vitest';
import { countKohEntries, installHooks, KOH_MARKER, uninstallHooks } from '../src/hooks/installer';

const BRIDGE = '/Users/jack/DEV/koh-claude/bin/koh-claude-bridge';

const existing = {
  model: 'opus',
  hooks: {
    PermissionRequest: [
      { matcher: '*', hooks: [{ type: 'command', command: '/vibe/bridge --source claude', timeout: 86400 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'mon-hook-a-moi' }] },
    ],
  },
};

describe('installHooks', () => {
  it('ajoute nos 8 entrées', () => {
    expect(countKohEntries(installHooks(existing, BRIDGE))).toBe(8);
  });

  it('préserve les entrées existantes', () => {
    const out = installHooks(existing, BRIDGE) as typeof existing;
    const perm = out.hooks.PermissionRequest.flatMap((e) => e.hooks.map((h) => h.command));
    expect(perm).toContain('/vibe/bridge --source claude');
    expect(out.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command))).toContain('mon-hook-a-moi');
    expect(out.model).toBe('opus');
  });

  it('ne rend jamais notre PermissionRequest bloquant', () => {
    const out = installHooks(existing, BRIDGE) as typeof existing;
    const ours = out.hooks.PermissionRequest.flatMap((e) => e.hooks).filter((h) =>
      h.command.includes(KOH_MARKER),
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]).not.toHaveProperty('timeout');
  });

  it('est idempotent', () => {
    const once = installHooks(existing, BRIDGE);
    expect(countKohEntries(installHooks(once, BRIDGE))).toBe(8);
  });

  it('fonctionne sur un settings.json sans hooks', () => {
    expect(countKohEntries(installHooks({}, BRIDGE))).toBe(8);
  });

  it('désinstalle uniquement les nôtres', () => {
    const out = uninstallHooks(installHooks(existing, BRIDGE)) as typeof existing;
    expect(countKohEntries(out)).toBe(0);
    expect(out.hooks.PermissionRequest.flatMap((e) => e.hooks.map((h) => h.command))).toContain(
      '/vibe/bridge --source claude',
    );
    expect(out.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command))).toContain('mon-hook-a-moi');
  });

  it('la désinstallation est idempotente', () => {
    expect(countKohEntries(uninstallHooks(uninstallHooks(installHooks(existing, BRIDGE))))).toBe(0);
  });
});
