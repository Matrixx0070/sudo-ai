/**
 * Compaction goal-pinning (Spec 7 acceptance #2) — the first user message
 * (the goal) is pinned verbatim across compaction.
 */
import { describe, it, expect } from 'vitest';
import { selectPinnedGoal, selectVerbatimTail } from '../../src/core/agent/loop-helpers.js';
import type { BrainMessage } from '../../src/core/brain/types.js';

const m = (role: BrainMessage['role'], content: string): BrainMessage => ({ role, content } as BrainMessage);

describe('selectPinnedGoal', () => {
  it('pins the FIRST user message when it is outside the verbatim tail (long session)', () => {
    const msgs: BrainMessage[] = [
      m('user', 'ORIGINAL GOAL: build the thing'),
      ...Array.from({ length: 30 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `turn ${i}`)),
    ];
    const tail = selectVerbatimTail(msgs, 6);
    const pinned = selectPinnedGoal(msgs, tail);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.role).toBe('system');
    expect(pinned[0]!.content).toContain('ORIGINAL GOAL: build the thing');
    expect(pinned[0]!.content).toMatch(/pinned goal/i);
    // The pinned goal is NOT already in the tail (long session).
    expect(tail.some((t) => (t.content as string).includes('ORIGINAL GOAL'))).toBe(false);
  });

  it('does NOT duplicate when the first user message is already in the tail (short session)', () => {
    const msgs: BrainMessage[] = [m('user', 'short goal'), m('assistant', 'ok')];
    const tail = selectVerbatimTail(msgs, 6);
    expect(tail.some((t) => (t.content as string) === 'short goal')).toBe(true);
    expect(selectPinnedGoal(msgs, tail)).toEqual([]);
  });

  it('returns [] when there is no user message', () => {
    expect(selectPinnedGoal([m('system', 's'), m('assistant', 'a')], [])).toEqual([]);
  });

  it('truncates a very long goal', () => {
    const big = 'g'.repeat(5000);
    const pinned = selectPinnedGoal([m('user', big)], []);
    expect(pinned[0]!.content.length).toBeLessThan(2100);
  });
});
