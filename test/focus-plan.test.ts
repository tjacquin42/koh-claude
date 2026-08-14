import { describe, expect, it } from 'vitest';
import { focusPlanFor } from '../src/focus/plan';
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
