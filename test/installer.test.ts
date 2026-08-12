import { describe, expect, it } from 'vitest';
import {
  countForeignEntries,
  countKohEntries,
  installHooks,
  KOH_MARKER,
  uninstallHooks,
} from '../src/hooks/installer';

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

// Reproduction du constat de revue : un événement réel de Claude Code que nous ne
// gérons pas (PostCompact) peut porter une entrée malformée, et un événement peut
// avoir une valeur qui n'est même pas un tableau. Rien de tout cela ne nous appartient
// et rien ne doit disparaître, ni à l'installation ni à la désinstallation.
const withUnknownForms = {
  ...existing,
  hooks: {
    ...existing.hooks,
    PostCompact: [{ matcher: '*', hooks: 'not-an-array' }],
    PreCompact: 'valeur-inattendue',
  },
};

describe('formes non reconnues', () => {
  it('préserve une entrée dont hooks n est pas un tableau, à l installation', () => {
    const out = installHooks(withUnknownForms, BRIDGE) as typeof withUnknownForms;
    expect(out.hooks.PostCompact).toEqual([{ matcher: '*', hooks: 'not-an-array' }]);
  });

  it('préserve un événement dont la valeur n est pas un tableau, à l installation', () => {
    const out = installHooks(withUnknownForms, BRIDGE) as typeof withUnknownForms;
    expect(out.hooks.PreCompact).toBe('valeur-inattendue');
  });

  it('préserve ces deux formes à la désinstallation', () => {
    const out = uninstallHooks(withUnknownForms) as typeof withUnknownForms;
    expect(out.hooks.PostCompact).toEqual([{ matcher: '*', hooks: 'not-an-array' }]);
    expect(out.hooks.PreCompact).toBe('valeur-inattendue');
  });

  it('un aller-retour rend l objet strictement identique en présence de ces formes', () => {
    const back = uninstallHooks(installHooks(withUnknownForms, BRIDGE));
    expect(back).toEqual(withUnknownForms);
  });
});

describe('countForeignEntries', () => {
  it('compte les commandes étrangères, y compris nichées dans une forme non reconnue', () => {
    // Vibe Island (PermissionRequest) + mon-hook-a-moi (PreToolUse) = 2, plus la
    // commande nichée sous la forme malformée reconnue comme du "hooks" non-tableau
    // ne compte pas puisqu'elle n'a pas de champ command ici — seules les deux
    // commandes réelles sont comptées.
    expect(countForeignEntries(existing)).toBe(2);
  });

  it('ne compte aucune commande étrangère sur un settings.json sans hooks', () => {
    expect(countForeignEntries({})).toBe(0);
  });

  it('ne compte pas nos propres commandes après installation', () => {
    const before = countForeignEntries(existing);
    const after = countForeignEntries(installHooks(existing, BRIDGE));
    expect(after).toBe(before);
  });
});
