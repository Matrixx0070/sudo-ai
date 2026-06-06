/**
 * @file tests/hooks/hook-runner.test.ts
 * @description Comprehensive tests for the 3-type hook runner system.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runVoidHook, runModifyingHook, runClaimingHook, sortHooksByPriority,
} from '../../src/core/hooks/hook-runner.js';
import type { PrioritizedHook, HookResult } from '../../src/core/hooks/hook-runner.js';
import type { HookContext, HookEvent } from '../../src/core/hooks/index.js';

const baseCtx: HookContext = { event: 'after:tool-call', toolName: 'readFile' };

function makeHook(
  id: string, handler: (ctx: HookContext) => Promise<unknown>, priority = 50, weight = 1,
): PrioritizedHook {
  return { id, event: 'after:tool-call' as HookEvent, handler: handler as PrioritizedHook['handler'], description: `test hook ${id}`, priority, weight };
}

describe('hook-runner', () => {
  // 1. runVoidHook: All handlers run in parallel, errors caught
  describe('runVoidHook', () => {
    it('runs all handlers in parallel and catches errors', async () => {
      const called: string[] = [];
      const hooks = [
        makeHook('a', async () => { called.push('a'); }),
        makeHook('b', async () => { throw new Error('boom'); }),
        makeHook('c', async () => { called.push('c'); }),
      ];
      await runVoidHook('after:tool-call', baseCtx, hooks);
      expect(called.sort()).toEqual(['a', 'c']);
    });

    // 5. runVoidHook timeout: Handler exceeding timeout is caught
    it('catches handlers that exceed the timeout', async () => {
      const slow = vi.fn(async () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('too slow')), 500);
      }));
      const fast = vi.fn(async () => {});
      await runVoidHook('after:tool-call', baseCtx,
        [makeHook('slow', slow), makeHook('fast', fast, 10)], { voidTimeout: 1 });
      expect(fast).toHaveBeenCalled();
    });

    // 8. Empty hooks: void runner handles empty array
    it('handles empty hooks array', async () => {
      await expect(runVoidHook('after:tool-call', baseCtx, [])).resolves.toBeUndefined();
    });

    // 10. Error isolation: One handler error doesn't affect others
    it('isolates errors so one failing handler does not affect others', async () => {
      const goodA = vi.fn(async () => {});
      const goodB = vi.fn(async () => {});
      await runVoidHook('after:tool-call', baseCtx, [
        makeHook('fail', async () => { throw new Error('fail'); }),
        makeHook('goodA', goodA), makeHook('goodB', goodB),
      ]);
      expect(goodA).toHaveBeenCalled();
      expect(goodB).toHaveBeenCalled();
    });
  });

  // 2. runModifyingHook: Context is passed sequentially, each handler can modify
  describe('runModifyingHook', () => {
    it('passes context sequentially so each handler can modify it', async () => {
      const hooks = [
        makeHook('first', async (ctx: HookContext) => ({ ...ctx, meta: { ...(ctx.meta ?? {}), step1: true } })),
        makeHook('second', async (ctx: HookContext) => ({ ...ctx, meta: { ...(ctx.meta ?? {}), step2: true } })),
      ];
      const result = await runModifyingHook('after:tool-call', baseCtx, hooks);
      expect(result.meta?.step1).toBe(true);
      expect(result.meta?.step2).toBe(true);
    });

    // 6. runModifyingHook transform: Context fields are modified correctly
    it('transforms context fields correctly through the chain', async () => {
      const hooks = [
        makeHook('rename', async (ctx: HookContext) => ({ ...ctx, toolName: 'writeFile', meta: { modified: true } })),
        makeHook('enrich', async (ctx: HookContext) => ({ ...ctx, meta: { ...ctx.meta!, enriched: true } })),
      ];
      const result = await runModifyingHook('after:tool-call', baseCtx, hooks);
      expect(result.toolName).toBe('writeFile');
      expect(result.meta?.modified).toBe(true);
      expect(result.meta?.enriched).toBe(true);
    });

    it('preserves last good context when a handler throws', async () => {
      const hooks = [
        makeHook('good', async (ctx: HookContext) => ({ ...ctx, meta: { added: true } })),
        makeHook('bad', async () => { throw new Error('fail'); }),
        makeHook('after', async (ctx: HookContext) => ({ ...ctx, meta: { ...ctx.meta!, after: true } })),
      ];
      const result = await runModifyingHook('after:tool-call', baseCtx, hooks);
      expect(result.meta?.added).toBe(true);
      expect(result.meta?.after).toBe(true);
    });

    it('preserves context when a handler times out', async () => {
      const result = await runModifyingHook('after:tool-call', baseCtx,
        [makeHook('slow', async () => new Promise(() => {}))], { modifyingTimeout: 1 });
      expect(result).toEqual(baseCtx);
    });

    // 8. Empty hooks: modifying runner handles empty array
    it('returns original context when hooks array is empty', async () => {
      expect(await runModifyingHook('after:tool-call', baseCtx, [])).toBe(baseCtx);
    });
  });

  // 3. runClaimingHook: First claim wins, subsequent handlers skipped
  describe('runClaimingHook', () => {
    it('first claim wins and subsequent handlers are skipped', async () => {
      let secondCalled = false;
      const result = await runClaimingHook('after:tool-call', baseCtx, [
        makeHook('claimer', async () => ({ blocked: true }), 90),
        makeHook('skipped', async () => { secondCalled = true; return null; }, 10),
      ]);
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
      expect(secondCalled).toBe(false);
    });

    // 7. runClaimingHook no claim: Returns null when no handler claims
    it('returns null when no handler claims', async () => {
      const result = await runClaimingHook('after:tool-call', baseCtx, [
        makeHook('p1', async () => null), makeHook('p2', async () => undefined),
      ]);
      expect(result).toBeNull();
    });

    // 8. Empty hooks: claiming runner handles empty array
    it('returns null for empty hooks array', async () => {
      expect(await runClaimingHook('after:tool-call', baseCtx, [])).toBeNull();
    });

    // 9. Mixed priorities: High-priority claiming hook runs first
    it('high-priority claiming hook claims before low-priority', async () => {
      const hooks = [
        makeHook('low', async () => ({ approval: 'denied' } as HookResult), 10),
        makeHook('high', async () => ({ approval: 'approved' } as HookResult), 90),
      ];
      const result = await runClaimingHook('after:tool-call', baseCtx, hooks);
      expect(result).not.toBeNull();
      expect(result!.approval).toBe('approved');
    });

    // 10. Error isolation: throwing handler treated as no-claim
    it('treats a throwing handler as no-claim and continues', async () => {
      const result = await runClaimingHook('after:tool-call', baseCtx, [
        makeHook('thrower', async () => { throw new Error('oops'); }, 90),
        makeHook('claimer', async () => ({ blocked: true } as HookResult), 10),
      ]);
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });

    it('attaches duration to claimed result', async () => {
      const result = await runClaimingHook('after:tool-call', baseCtx,
        [makeHook('fast', async () => ({ blocked: false }), 50)]);
      expect(result).not.toBeNull();
      expect(result!.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // 4. Priority sorting: Hooks sorted by priority descending
  describe('sortHooksByPriority', () => {
    it('sorts hooks by priority descending', () => {
      const hooks = [makeHook('a', async () => {}, 10), makeHook('b', async () => {}, 90), makeHook('c', async () => {}, 50)];
      expect(sortHooksByPriority(hooks).map((h) => h.id)).toEqual(['b', 'c', 'a']);
    });

    it('uses weight as tiebreaker when priorities are equal', () => {
      const hooks = [makeHook('a', async () => {}, 50, 1), makeHook('b', async () => {}, 50, 10), makeHook('c', async () => {}, 50, 5)];
      expect(sortHooksByPriority(hooks).map((h) => h.id)).toEqual(['b', 'c', 'a']);
    });

    it('does not mutate the input array', () => {
      const hooks = [makeHook('a', async () => {}, 10), makeHook('b', async () => {}, 90)];
      const ids = hooks.map((h) => h.id);
      sortHooksByPriority(hooks);
      expect(hooks.map((h) => h.id)).toEqual(ids);
    });

    // 9. Mixed priorities with weight tiebreakers
    it('handles mixed priorities and weights', () => {
      const hooks = [
        makeHook('low', async () => {}, 10, 99),
        makeHook('high-heavy', async () => {}, 90, 5),
        makeHook('high-light', async () => {}, 90, 1),
        makeHook('mid', async () => {}, 50, 1),
      ];
      expect(sortHooksByPriority(hooks).map((h) => h.id)).toEqual(['high-heavy', 'high-light', 'mid', 'low']);
    });
  });
});