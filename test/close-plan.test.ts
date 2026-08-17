import { describe, expect, it } from 'vitest';
import { closePlan } from '../src/close/plan';

describe('closePlan', () => {
  it('closes the tab of an editor conversation', () => {
    expect(closePlan('vscode')).toEqual({ kind: 'tab' });
  });

  it('only forgets a desktop conversation, unlike focusPlan', () => {
    expect(closePlan('desktop')).toEqual({ kind: 'forget' });
  });

  it('only forgets a terminal conversation', () => {
    expect(closePlan('terminal')).toEqual({ kind: 'forget' });
  });

  it('only forgets an sdk conversation', () => {
    expect(closePlan('sdk')).toEqual({ kind: 'forget' });
  });

  it('only forgets a conversation whose origin is unknown', () => {
    expect(closePlan('unknown')).toEqual({ kind: 'forget' });
  });

  it('only forgets a missing, wrongly typed or wrongly cased origin', () => {
    for (const origin of [undefined, null, 42, {}, [], 'VSCODE', '']) {
      expect(closePlan(origin)).toEqual({ kind: 'forget' });
    }
  });
});
