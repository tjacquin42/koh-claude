import { describe, expect, it } from 'vitest';
import {
  installStatusLine,
  uninstallStatusLine,
  wrappedStatusLine,
} from '../src/hooks/installer';

const BRIDGE = '/Users/dev/.koh-vibe/bin/koh-vibe-statusline';
const FOREIGN = '/Users/dev/.vibe-island/bin/vibe-island-statusline';

const commandOf = (settings: unknown): string | undefined =>
  (settings as { statusLine?: { command?: string } }).statusLine?.command;

describe('installStatusLine', () => {
  it('prend la place quand elle est libre', () => {
    const after = installStatusLine({}, BRIDGE);
    expect(commandOf(after)).toContain(BRIDGE);
    expect(wrappedStatusLine(after)).toBe('');
  });

  it('enveloppe la commande qui occupait la place, sans la perdre', () => {
    const after = installStatusLine({ statusLine: { type: 'command', command: FOREIGN } }, BRIDGE);
    expect(wrappedStatusLine(after)).toBe(FOREIGN);
  });

  it('encode la commande précédente : ni apostrophe ni guillemet ne traverse en clair', () => {
    const tordue = `/bin/sh -c 'echo "salut" && jq -r .x'`;
    const after = installStatusLine({ statusLine: { type: 'command', command: tordue } }, BRIDGE);
    const command = commandOf(after) ?? '';
    expect(command).not.toContain('echo');
    expect(wrappedStatusLine(after)).toBe(tordue);
  });

  it('ne s imbrique pas quand on réinstalle par-dessus soi-même', () => {
    const once = installStatusLine({ statusLine: { type: 'command', command: FOREIGN } }, BRIDGE);
    const twice = installStatusLine(once, BRIDGE);
    expect(wrappedStatusLine(twice)).toBe(FOREIGN);
    expect(commandOf(twice)).toBe(commandOf(once));
  });

  it('garde un repli qui lance la commande précédente si notre pont a disparu', () => {
    const after = installStatusLine({ statusLine: { type: 'command', command: FOREIGN } }, BRIDGE);
    const command = commandOf(after) ?? '';
    // Deux exec : le nôtre sous condition, celui du repli sans condition.
    expect(command).toContain('[ -x "');
    expect(command.match(/exec/g) ?? []).toHaveLength(2);
  });

  it('ne touche à rien d autre dans le fichier', () => {
    const after = installStatusLine({ model: 'opus', hooks: { Stop: [] } }, BRIDGE);
    expect((after as { model?: string }).model).toBe('opus');
    expect((after as { hooks?: unknown }).hooks).toEqual({ Stop: [] });
  });
});

describe('wrappedStatusLine', () => {
  it('ne reconnaît pas une commande étrangère qui mentionne notre pont', () => {
    // Le piège que la reconnaissance par sous-chaîne laisserait passer : cette
    // commande serait classée comme nôtre, puis supprimée à la désinstallation.
    const settings = { statusLine: { type: 'command', command: `/bin/sh -c 'autre && ${BRIDGE}'` } };
    expect(wrappedStatusLine(settings)).toBeUndefined();
  });

  it('ne reconnaît pas un pont dont le nom se termine autrement', () => {
    const settings = installStatusLine({}, '/Users/dev/bin/pas-notre-statusline');
    expect(wrappedStatusLine(settings)).toBeUndefined();
  });

  it('ignore une statusline absente ou de forme inattendue', () => {
    expect(wrappedStatusLine({})).toBeUndefined();
    expect(wrappedStatusLine({ statusLine: 'une chaîne' })).toBeUndefined();
    expect(wrappedStatusLine({ statusLine: { type: 'command' } })).toBeUndefined();
    expect(wrappedStatusLine(null)).toBeUndefined();
  });
});

describe('uninstallStatusLine', () => {
  it('rend la place à qui l occupait', () => {
    const after = uninstallStatusLine(installStatusLine({ statusLine: { type: 'command', command: FOREIGN } }, BRIDGE));
    expect(commandOf(after)).toBe(FOREIGN);
  });

  it('retire la clé quand nous n enveloppions rien', () => {
    const after = uninstallStatusLine(installStatusLine({}, BRIDGE));
    expect(after).not.toHaveProperty('statusLine');
  });

  it('ne touche pas à une statusline qui n est pas la nôtre', () => {
    const settings = { statusLine: { type: 'command', command: FOREIGN } };
    expect(uninstallStatusLine(settings)).toEqual(settings);
  });

  it('fait l aller-retour complet sans rien changer', () => {
    const before = { statusLine: { type: 'command', command: FOREIGN }, model: 'opus' };
    expect(uninstallStatusLine(installStatusLine(before, BRIDGE))).toEqual(before);
  });
});
