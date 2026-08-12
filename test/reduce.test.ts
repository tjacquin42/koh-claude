import { describe, expect, it } from 'vitest';
import { reduce, reduceAll } from '../src/store/reduce';
import type { EventName, SpoolEvent } from '../src/events/types';

let clock = 1000;
function ev(event: EventName, extra: Partial<SpoolEvent> = {}): SpoolEvent {
  clock += 10;
  return {
    event,
    at: clock,
    entrypoint: 'claude-vscode',
    termProgram: 'vscode',
    sessionId: 's1',
    cwd: '/Users/dev/projet',
    ...extra,
  };
}

describe('reduce', () => {
  it('crée la session au SessionStart, à l arrêt', () => {
    const s = reduce(undefined, ev('SessionStart', { transcriptPath: '/t.jsonl' }));
    expect(s?.status).toBe('idle');
    expect(s?.project).toBe('projet');
    expect(s?.origin).toBe('vscode');
    expect(s?.transcriptPath).toBe('/t.jsonl');
    expect(s?.startedAt).toBeDefined();
  });

  it('crée la session même sans SessionStart', () => {
    const s = reduce(undefined, ev('PreToolUse', { toolName: 'Bash' }));
    expect(s?.status).toBe('running');
    expect(s?.startedAt).toBeUndefined();
  });

  it('passe en cours au prompt', () => {
    const a = reduce(undefined, ev('SessionStart'));
    expect(reduce(a, ev('UserPromptSubmit'))?.status).toBe('running');
  });

  it('affiche l action en cours et la retire au PostToolUse', () => {
    const a = reduce(undefined, ev('PreToolUse', { toolName: 'Edit', toolTarget: '/x/a.ts' }));
    expect(a?.currentAction).toEqual({ tool: 'Edit', target: '/x/a.ts' });
    expect(a?.inFlightSince).toBeDefined();
    const b = reduce(a, ev('PostToolUse', { toolName: 'Edit' }));
    expect(b?.currentAction).toBeUndefined();
    expect(b?.inFlightSince).toBeUndefined();
    expect(b?.toolCount).toBe(1);
  });

  it('passe en attente sur PermissionRequest, avec le détail', () => {
    const a = reduce(undefined, ev('PreToolUse', { toolName: 'Bash' }));
    const b = reduce(a, ev('PermissionRequest', { toolName: 'Bash', toolTarget: 'rm -rf dist' }));
    expect(b?.status).toBe('waiting');
    expect(b?.pendingPermission).toEqual({ tool: 'Bash', summary: 'rm -rf dist' });
  });

  it('passe en attente sur Notification', () => {
    const a = reduce(undefined, ev('UserPromptSubmit'));
    expect(reduce(a, ev('Notification', { message: 'attend ton accord' }))?.status).toBe('waiting');
  });

  it('sort de l attente quand un outil repart', () => {
    const a = reduce(undefined, ev('PermissionRequest', { toolName: 'Bash' }));
    const b = reduce(a, ev('PreToolUse', { toolName: 'Bash' }));
    expect(b?.status).toBe('running');
    expect(b?.pendingPermission).toBeUndefined();
  });

  it('termine non lu, puis à l arrêt après acquittement', () => {
    const a = reduce(undefined, ev('UserPromptSubmit'));
    const b = reduce(a, ev('Stop'));
    expect(b?.status).toBe('done_unseen');
    expect(reduce(b, ev('Ack'))?.status).toBe('idle');
  });

  it('un Ack sur une session en cours ne change rien', () => {
    const a = reduce(undefined, ev('PreToolUse', { toolName: 'Bash' }));
    expect(reduce(a, ev('Ack'))?.status).toBe('running');
  });

  it('SessionEnd retire la session', () => {
    const a = reduce(undefined, ev('SessionStart'));
    expect(reduce(a, ev('SessionEnd'))).toBeUndefined();
  });

  it('un Ack sur une session absente ne crée rien : seul un événement de hook fait naître une session', () => {
    expect(reduce(undefined, ev('Ack'))).toBeUndefined();
  });

  it('un événement en retard ne fait pas régresser le statut', () => {
    const a = reduce(undefined, ev('Stop'));
    const late: SpoolEvent = { ...ev('UserPromptSubmit'), at: 1 };
    expect(reduce(a, late)?.status).toBe('done_unseen');
  });

  it('mais ses effets cumulatifs comptent', () => {
    const a = reduce(undefined, ev('Stop'));
    const late: SpoolEvent = { ...ev('PostToolUse'), at: 1 };
    expect(reduce(a, late)?.toolCount).toBe(1);
    expect(reduce(a, late)?.lastEventAt).toBe(a?.lastEventAt);
  });

  it('tient plusieurs sessions et un worktree', () => {
    const map = reduceAll([
      ev('SessionStart', { sessionId: 'a' }),
      ev('PreToolUse', { sessionId: 'b', cwd: '/Users/dev/projet/.worktrees/feat-seo' }),
      ev('Stop', { sessionId: 'a' }),
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')?.status).toBe('done_unseen');
    expect(map.get('b')?.branch).toBe('feat-seo');
    expect(map.get('b')?.project).toBe('projet');
  });
});
