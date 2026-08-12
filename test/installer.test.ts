import { describe, expect, it } from 'vitest';
import {
  countKohEntries,
  foreignFingerprint,
  installHooks,
  KOH_MARKER,
  uninstallHooks,
} from '../src/hooks/installer';

const BRIDGE = '/Users/dev/koh-claude/bin/koh-claude-bridge';

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

  it("retire la clé hooks plutôt que de laisser un objet vide quand il ne reste rien, ni à nous ni à personne (M5)", () => {
    const out = uninstallHooks(installHooks({}, BRIDGE)) as Record<string, unknown>;
    expect(out).not.toHaveProperty('hooks');
    // Le garde-fou d'empreinte doit rester intact : rien n'a changé pour lui,
    // qu'il reste "hooks": {} ou que la clé disparaisse.
    expect(foreignFingerprint(out)).toEqual([]);
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

describe('foreignFingerprint', () => {
  it('qualifie chaque commande étrangère par son ascendance en noms', () => {
    expect(foreignFingerprint(existing)).toEqual([
      '["hooks","PermissionRequest","*",{"type":"command","command":"/vibe/bridge --source claude","timeout":86400}]',
      '["hooks","PreToolUse","Bash",{"type":"command","command":"mon-hook-a-moi"}]',
    ]);
  });

  it('rend un tableau vide sur un settings.json sans hooks', () => {
    expect(foreignFingerprint({})).toEqual([]);
  });

  it('ne change pas après installation', () => {
    expect(foreignFingerprint(installHooks(existing, BRIDGE))).toEqual(foreignFingerprint(existing));
  });

  it('ne change pas après un aller-retour, même en présence de formes non reconnues', () => {
    const back = uninstallHooks(installHooks(withUnknownForms, BRIDGE));
    expect(foreignFingerprint(back)).toEqual(foreignFingerprint(withUnknownForms));
  });

  // Contre-exemples de la re-revue : un simple compte de commandes étrangères rend le
  // même nombre pour ces deux paires d'arbres alors qu'une commande a objectivement
  // changé de place, ou a été perdue en même temps qu'une autre apparaissait.
  // L'empreinte, qualifiée par ascendance, doit les distinguer — sinon le garde-fou du
  // script laisserait passer une régression comme celle du Constat 1.
  it('distingue une commande étrangère déplacée d un événement à un autre', () => {
    const treeA = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'foo' }] }],
        PostToolUse: [],
      },
    };
    const treeB = {
      hooks: {
        PreToolUse: [],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'foo' }] }],
      },
    };
    expect(foreignFingerprint(treeA)).not.toEqual(foreignFingerprint(treeB));
  });

  it('distingue une commande étrangère perdue en même temps qu une autre apparaît', () => {
    const treeC = {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'foo' }] }] },
    };
    const treeD = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bar-completement-different' }] }],
      },
    };
    expect(foreignFingerprint(treeC)).not.toEqual(foreignFingerprint(treeD));
  });

  // Contre-exemple de la re-revue (tour 3, point 2) : la clé d'ascendance était bâtie
  // par concaténation avec un séparateur ('.'), donc injectable. Un événement nommé
  // "PreToolUse.Bash" avec un matcher "foo" produisait la même clé qu'un événement
  // "PreToolUse" avec un matcher "Bash.foo", alors que ce sont deux emplacements
  // réellement distincts. L'ascendance encodée comme suite de segments (tableau JSON)
  // doit les distinguer.
  it('distingue deux ascendances réellement différentes que la concaténation confondrait', () => {
    const treeA = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash.foo', hooks: [{ type: 'command', command: 'evil' }] }],
      },
    };
    const treeB = {
      hooks: {
        'PreToolUse.Bash': [{ matcher: 'foo', hooks: [{ type: 'command', command: 'evil' }] }],
      },
    };
    expect(foreignFingerprint(treeA)).not.toEqual(foreignFingerprint(treeB));
  });

  // Tour 3, point 3 : les deux tests ci-dessous meurent si on retire la branche de
  // foreignFingerprint qui fait entrer la forme non classable correspondante dans
  // l'empreinte — contrairement à un test qui compare deux objets déjà identiques
  // (aveugle des deux côtés à une telle suppression). La forme qui marche est
  // l'asymétrie : l'empreinte d'un arbre qui porte la forme malformée doit différer de
  // l'empreinte du même arbre qui en est privé.
  it('une valeur d événement non-tableau se distingue de son absence dans l empreinte', () => {
    const withForm = { hooks: { PreCompact: 'valeur-inattendue' } };
    const withoutForm = { hooks: {} };
    expect(foreignFingerprint(withForm)).not.toEqual(foreignFingerprint(withoutForm));
  });

  it('une entrée de matcher dont hooks n est pas un tableau se distingue de son absence', () => {
    const withForm = { hooks: { PostCompact: [{ matcher: '*', hooks: 'not-an-array' }] } };
    const withoutForm = { hooks: { PostCompact: [] } };
    expect(foreignFingerprint(withForm)).not.toEqual(foreignFingerprint(withoutForm));
  });
});

// Tour 3, point 1 : isOurs comparait par sous-chaîne (`command.includes(KOH_MARKER)`),
// ce qui classait comme nôtre toute commande étrangère mentionnant notre bridge en
// passant — installHooks/uninstallHooks la supprimait, et foreignFingerprint, qui
// partage ce même prédicat, ne la voyait pas non plus disparaître. isOurs reconnaît
// désormais exactement le gabarit que nous écrivons, jamais une commande qui le contient.
describe('isOurs (précision de la reconnaissance)', () => {
  it('ne classe pas comme nôtre une commande étrangère qui enrobe notre bridge', () => {
    const wrapped = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: "sh -c 'autre-chose && ~/.koh-claude/bin/koh-claude-bridge'" }],
          },
        ],
      },
    };
    const out = uninstallHooks(wrapped) as typeof wrapped;
    expect(out.hooks.PreToolUse[0]?.hooks.map((h) => h.command)).toContain(
      "sh -c 'autre-chose && ~/.koh-claude/bin/koh-claude-bridge'",
    );
    expect(foreignFingerprint(wrapped).length).toBeGreaterThan(0);
  });

  it('reconnaît exactement notre propre commande installée : rien d étranger après une installation à vide', () => {
    const out = installHooks({}, BRIDGE);
    expect(foreignFingerprint(out)).toEqual([]);
  });
});
