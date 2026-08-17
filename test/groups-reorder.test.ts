import { describe, expect, it } from 'vitest';
import { emptyGroups, reorderGroups, type GroupsState } from '../src/groups/model';

const state = (...names: string[]): GroupsState => ({
  ...emptyGroups(),
  groups: names.map((id, order) => ({ id, name: id.toUpperCase(), order })),
});

const ids = (s: GroupsState): string[] => s.groups.map((g) => g.id);
const orders = (s: GroupsState): number[] => s.groups.map((g) => g.order);

describe('reorderGroups', () => {
  it('puts the moved folder in front of the target', () => {
    expect(ids(reorderGroups(state('a', 'b', 'c'), ['c'], 'b'))).toEqual(['a', 'c', 'b']);
  });

  it('moves a folder forward as well as backward', () => {
    expect(ids(reorderGroups(state('a', 'b', 'c'), ['a'], 'c'))).toEqual(['b', 'a', 'c']);
  });

  it('sends it to the end when no target is named', () => {
    expect(ids(reorderGroups(state('a', 'b', 'c'), ['a'], undefined))).toEqual(['b', 'c', 'a']);
  });

  it('renumbers every order densely, so two folders never share one', () => {
    const s = reorderGroups(state('a', 'b', 'c', 'd'), ['d'], 'b');
    expect(orders(s)).toEqual([0, 1, 2, 3]);
    expect(ids(s)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('keeps a multiple selection in the order it is displayed, not the order it was picked', () => {
    // VSCode reports a selection in click order; the file is the only truth
    // about what the user sees.
    expect(ids(reorderGroups(state('a', 'b', 'c', 'd'), ['c', 'a'], 'd'))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('sends the folders to the end rather than doing nothing when the target is unknown', () => {
    expect(ids(reorderGroups(state('a', 'b'), ['a'], 'gone'))).toEqual(['b', 'a']);
  });

  it('sends them to the end when the target is one of the moved folders itself', () => {
    expect(ids(reorderGroups(state('a', 'b', 'c'), ['a', 'b'], 'a'))).toEqual(['c', 'a', 'b']);
  });

  it('changes nothing, and returns the same state, when no known folder is moved', () => {
    const s = state('a', 'b');
    expect(reorderGroups(s, ['gone'], 'a')).toBe(s);
  });

  it('leaves the rest of the state alone', () => {
    const s: GroupsState = { ...state('a', 'b'), assignments: { s1: 'a' } };
    expect(reorderGroups(s, ['b'], 'a').assignments).toEqual({ s1: 'a' });
  });
});
