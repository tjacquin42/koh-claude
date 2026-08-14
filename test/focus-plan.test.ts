import { describe, expect, it } from 'vitest';
import { focusPlan, focusPlanFor } from '../src/focus/plan';
import { sessionLabel } from '../src/ui/labels';
import type { Session } from '../src/events/types';

const base: Session = {
  id: 'sess-1', cwd: '/Users/dev/projet', project: 'projet', origin: 'vscode',
  status: 'running', toolCount: 0, lastEventAt: 1,
};

describe('focusPlanFor', () => {
  it('révèle le panneau d une session vscode, par son identifiant', () => {
    expect(focusPlanFor(base)).toEqual({
      kind: 'command', command: 'claude-vscode.editor.open', args: ['sess-1'],
    });
  });

  it('fait de même pour une session desktop', () => {
    expect(focusPlanFor({ ...base, origin: 'desktop' })).toEqual({
      kind: 'command', command: 'claude-vscode.editor.open', args: ['sess-1'],
    });
  });

  it('n ouvre rien pour une session terminal et le dit', () => {
    const p = focusPlanFor({ ...base, origin: 'terminal' });
    expect(p.kind).toBe('explain');
    if (p.kind === 'explain') expect(p.message).toContain('terminal');
  });

  it('n ouvre rien non plus pour sdk et unknown', () => {
    expect(focusPlanFor({ ...base, origin: 'sdk' }).kind).toBe('explain');
    expect(focusPlanFor({ ...base, origin: 'unknown' }).kind).toBe('explain');
  });
});

// `focusPlan` est la règle unique dont `focusPlanFor` (chemin local, une
// `Session` complète) et le broker (chemin distant, seulement sessionId /
// origin / label lus depuis un fichier de requête) sont deux appelants —
// jamais deux copies de la même décision.
describe('focusPlan — la règle partagée par les deux chemins', () => {
  it('révèle par identifiant pour vscode ou desktop', () => {
    expect(focusPlan('sess-1', 'vscode', 'projet')).toEqual({
      kind: 'command', command: 'claude-vscode.editor.open', args: ['sess-1'],
    });
    expect(focusPlan('sess-1', 'desktop', 'projet')).toEqual({
      kind: 'command', command: 'claude-vscode.editor.open', args: ['sess-1'],
    });
  });

  it('explique pour toute autre origine, y compris absente (requête d une version antérieure)', () => {
    expect(focusPlan('sess-1', 'terminal', 'projet').kind).toBe('explain');
    expect(focusPlan('sess-1', undefined, 'projet').kind).toBe('explain');
    expect(focusPlan('sess-1', 'n-importe-quoi', 'projet').kind).toBe('explain');
  });

  it('focusPlanFor(session) délègue à focusPlan, elle n encode pas sa propre règle', () => {
    for (const origin of ['vscode', 'desktop', 'terminal', 'sdk', 'unknown'] as const) {
      const s = { ...base, origin };
      expect(focusPlanFor(s)).toEqual(focusPlan(s.id, s.origin, sessionLabel(s)));
    }
  });
});
