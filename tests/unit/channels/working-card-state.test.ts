/**
 * TX3 — working-card-state registry tests (pure, no telegram imports).
 */
import { describe, expect, it } from 'vitest';
import {
  getWorkingCard,
  registerWorkingCard,
  toggleWorkingCardDetail,
  unregisterWorkingCard,
  workingCardCount,
} from '../../../src/core/channels/working-card-state.js';

function makeEntry(initial = false): {
  entry: Parameters<typeof registerWorkingCard>[0];
  state: { detail: boolean; rerenders: number };
} {
  const state = { detail: initial, rerenders: 0 };
  return {
    state,
    entry: {
      getDetail: () => state.detail,
      setDetail: (d: boolean) => { state.detail = d; },
      rerender: () => { state.rerenders++; },
    },
  };
}

describe('working-card-state', () => {
  it('registers, looks up, and unregisters entries', () => {
    const before = workingCardCount();
    const { entry } = makeEntry();
    const token = registerWorkingCard(entry);
    expect(token.length).toBeGreaterThanOrEqual(8);
    expect(getWorkingCard(token)).toBe(entry);
    expect(workingCardCount()).toBe(before + 1);
    unregisterWorkingCard(token);
    expect(getWorkingCard(token)).toBeUndefined();
    expect(workingCardCount()).toBe(before);
  });

  it('toggle flips detail, triggers rerender, and returns the new value', () => {
    const { entry, state } = makeEntry(false);
    const token = registerWorkingCard(entry);
    expect(toggleWorkingCardDetail(token)).toBe(true);
    expect(state.detail).toBe(true);
    expect(state.rerenders).toBe(1);
    expect(toggleWorkingCardDetail(token)).toBe(false); // toggles back
    expect(state.detail).toBe(false);
    expect(state.rerenders).toBe(2);
    unregisterWorkingCard(token);
  });

  it('toggle on an unknown / finished token returns null', () => {
    expect(toggleWorkingCardDetail('no-such-token')).toBeNull();
    const { entry } = makeEntry();
    const token = registerWorkingCard(entry);
    unregisterWorkingCard(token);
    expect(toggleWorkingCardDetail(token)).toBeNull();
  });

  it('survives a throwing rerender (state still flipped)', () => {
    let detail = false;
    const token = registerWorkingCard({
      getDetail: () => detail,
      setDetail: (d) => { detail = d; },
      rerender: () => { throw new Error('edit failed'); },
    });
    expect(toggleWorkingCardDetail(token)).toBe(true);
    expect(detail).toBe(true);
    unregisterWorkingCard(token);
  });

  it('unregister is idempotent', () => {
    const { entry } = makeEntry();
    const token = registerWorkingCard(entry);
    unregisterWorkingCard(token);
    unregisterWorkingCard(token);
    expect(getWorkingCard(token)).toBeUndefined();
  });

  it('evicts the oldest entry at the cap instead of growing unbounded', () => {
    const tokens: string[] = [];
    for (let i = 0; i < 140; i++) tokens.push(registerWorkingCard(makeEntry().entry));
    expect(workingCardCount()).toBeLessThanOrEqual(128);
    // Oldest evicted, newest alive.
    expect(getWorkingCard(tokens[0]!)).toBeUndefined();
    expect(getWorkingCard(tokens[tokens.length - 1]!)).toBeDefined();
    for (const t of tokens) unregisterWorkingCard(t);
  });
});
