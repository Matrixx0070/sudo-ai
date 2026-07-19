import { describe, it, expect, vi } from 'vitest';
import { shouldAutoHibernate } from '../../src/core/agent/loop.js';

/**
 * F110 — the loop calls the injected auto-hibernation checkpoint seam at the
 * safe iteration boundary, and never when the seam is not injected ("off").
 *
 * The loop's boundary gate is the exported pure predicate `shouldAutoHibernate`
 * (loop.ts:2181 calls it inline). We drive that exact predicate against a mock
 * seam to prove: call-under-flag at the boundary, no-call when off.
 */
describe('F110 — loop-side auto-hibernation boundary gate', () => {
  const every = 25;

  it('does NOT fire the seam when no callback is injected (off)', () => {
    const seam = vi.fn();
    // Even on a perfect cadence boundary, hasCallback=false -> no call.
    if (shouldAutoHibernate(false, every, every)) seam();
    if (shouldAutoHibernate(false, every * 2, every)) seam();
    expect(seam).not.toHaveBeenCalled();
  });

  it('fires the seam exactly at the cadence boundary when injected', () => {
    const seam = vi.fn();
    const snap = { sessionId: 's', plan: 'p', stepCursor: every, toolResultDigests: [] };
    // Mirror the loop's inline block: gate then call.
    if (shouldAutoHibernate(seam != null, every, every)) seam(snap);
    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith(snap);
  });

  it('does not fire off-cadence or before the first boundary', () => {
    expect(shouldAutoHibernate(true, 1, every)).toBe(false);
    expect(shouldAutoHibernate(true, every - 1, every)).toBe(false);
    expect(shouldAutoHibernate(true, every + 1, every)).toBe(false);
    expect(shouldAutoHibernate(true, every, every)).toBe(true);
    expect(shouldAutoHibernate(true, every * 3, every)).toBe(true);
  });

  it('treats a non-positive cadence as disabled (never divides by zero)', () => {
    expect(shouldAutoHibernate(true, 0, 0)).toBe(false);
    expect(shouldAutoHibernate(true, 10, 0)).toBe(false);
  });
});
