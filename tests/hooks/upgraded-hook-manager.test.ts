/**
 * @file tests/hooks/upgraded-hook-manager.test.ts
 * @description Tests for the upgraded HookManager with priority, emitVoid,
 *              emitModifying, emitClaiming, and backward-compatible emit().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../../src/core/hooks/index.js';
import type { HookContext, HookEvent } from '../../src/core/hooks/index.js';

// -- Helpers --

const baseCtx: HookContext = { event: 'after:tool-call', toolName: 'readFile' };

function makeCtx(event: HookEvent, extra?: Partial<HookContext>): HookContext {
  return { event, ...baseCtx, ...extra };
}

// -- Tests --

describe('HookManager', () => {
  let mgr: HookManager;

  beforeEach(() => {
    mgr = new HookManager();
  });

  describe('register with priority', () => {
    it('stores priority and weight on the hook', () => {
      const id = mgr.register('after:tool-call', async () => {}, 'test', { priority: 80, weight: 5 });
      const hooks = mgr.listHooks();
      const hook = hooks.find((h) => h.id === id);
      expect(hook).toBeDefined();
      expect(hook!.priority).toBe(80);
      expect(hook!.weight).toBe(5);
    });

    it('defaults priority to 50 and weight to 1 when not specified', () => {
      const id = mgr.register('after:tool-call', async () => {}, 'no-prio');
      const hook = mgr.listHooks().find((h) => h.id === id);
      expect(hook!.priority).toBe(50);
      expect(hook!.weight).toBe(1);
    });

    it('sorts hooks by priority descending within the same event', () => {
      mgr.register('after:tool-call', async () => {}, 'low', { priority: 10 });
      mgr.register('after:tool-call', async () => {}, 'high', { priority: 90 });
      mgr.register('after:tool-call', async () => {}, 'mid', { priority: 50 });
      const list = mgr.listHooks().filter((h) => h.event === 'after:tool-call');
      const priorities = list.map((h) => h.priority);
      expect(priorities).toEqual([90, 50, 10]);
    });
  });

  describe('emitVoid — fire-and-forget', () => {
    it('runs all handlers in parallel and returns void', async () => {
      const called: string[] = [];
      mgr.register('after:tool-call', async () => { called.push('a'); });
      mgr.register('after:tool-call', async () => { called.push('b'); });
      await mgr.emitVoid('after:tool-call', makeCtx('after:tool-call'));
      expect(called.sort()).toEqual(['a', 'b']);
    });

    it('does nothing when no hooks are registered', async () => {
      await expect(mgr.emitVoid('on:error', makeCtx('on:error'))).resolves.toBeUndefined();
    });
  });

  describe('emitModifying — sequential context mutation', () => {
    it('threads context through each handler in order', async () => {
      mgr.register('before:brain-call', async (ctx) => ({
        ...ctx, meta: { ...(ctx.meta ?? {}), step1: true },
      }), 'step1', { priority: 90 });
      mgr.register('before:brain-call', async (ctx) => ({
        ...ctx, meta: { ...(ctx.meta ?? {}), step2: true },
      }), 'step2', { priority: 10 });
      const result = await mgr.emitModifying('before:brain-call', makeCtx('before:brain-call'));
      expect(result.meta?.step1).toBe(true);
      expect(result.meta?.step2).toBe(true);
    });

    it('returns original context when no hooks registered', async () => {
      const ctx = makeCtx('before:brain-call');
      const result = await mgr.emitModifying('before:brain-call', ctx);
      expect(result).toBe(ctx);
    });
  });

  describe('emitClaiming — first-claim-wins', () => {
    it('returns the first non-null claim result', async () => {
      mgr.register('before:tool-call', async () => ({ blocked: true }), 'security', { priority: 90 });
      mgr.register('before:tool-call', async () => ({ blocked: false }), 'fallback', { priority: 10 });
      const result = await mgr.emitClaiming('before:tool-call', makeCtx('before:tool-call'));
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });

    it('returns null when no handler claims', async () => {
      mgr.register('before:tool-call', async () => null, 'pass');
      const result = await mgr.emitClaiming('before:tool-call', makeCtx('before:tool-call'));
      expect(result).toBeNull();
    });

    it('returns null when no hooks registered', async () => {
      const result = await mgr.emitClaiming('on:error', makeCtx('on:error'));
      expect(result).toBeNull();
    });
  });

  describe('backward compat — emit()', () => {
    it('fires all handlers sequentially (legacy behavior)', async () => {
      const order: string[] = [];
      mgr.register('on:message', async () => { order.push('first'); }, 'h1', { priority: 90 });
      mgr.register('on:message', async () => { order.push('second'); }, 'h2', { priority: 10 });
      await mgr.emit('on:message', makeCtx('on:message', { message: 'hi' }));
      expect(order).toEqual(['first', 'second']);
    });

    it('swallows handler errors and continues', async () => {
      const good = vi.fn(async () => {});
      mgr.register('on:message', async () => { throw new Error('oops'); }, 'bad');
      mgr.register('on:message', good, 'good');
      await mgr.emit('on:message', makeCtx('on:message'));
      expect(good).toHaveBeenCalled();
    });

    it('does nothing when no hooks registered for event', async () => {
      await expect(mgr.emit('on:error', makeCtx('on:error'))).resolves.toBeUndefined();
    });
  });

  describe('unregister with new format', () => {
    it('removes a hook by its ID', () => {
      const id = mgr.register('after:tool-call', async () => {}, 'removable');
      expect(mgr.size).toBe(1);
      mgr.unregister(id);
      expect(mgr.size).toBe(0);
    });

    it('silently ignores unknown IDs', () => {
      mgr.register('after:tool-call', async () => {}, 'keep');
      mgr.unregister('nonexistent-id');
      expect(mgr.size).toBe(1);
    });
  });

  describe('mixed priority and old-style hooks', () => {
    it('runs hooks with explicit priority before default-priority hooks', async () => {
      const order: string[] = [];
      mgr.register('after:tool-call', async () => { order.push('default'); }, 'default-prio');
      mgr.register('after:tool-call', async () => { order.push('high'); }, 'high-prio', { priority: 90 });
      mgr.register('after:tool-call', async () => { order.push('low'); }, 'low-prio', { priority: 10 });
      await mgr.emit('after:tool-call', makeCtx('after:tool-call'));
      // Priority order: high (90), default (50), low (10)
      expect(order).toEqual(['high', 'default', 'low']);
    });

    it('emitModifying respects priority order for context threading', async () => {
      mgr.register('before:brain-call', async (ctx) => ({
        ...ctx, meta: { order: [...(ctx.meta?.order ?? []), 'second'] },
      }), 'mid', { priority: 50 });
      mgr.register('before:brain-call', async (ctx) => ({
        ...ctx, meta: { order: [...(ctx.meta?.order ?? []), 'first'] },
      }), 'high', { priority: 90 });
      const result = await mgr.emitModifying('before:brain-call', makeCtx('before:brain-call'));
      expect(result.meta?.order).toEqual(['first', 'second']);
    });
  });
});