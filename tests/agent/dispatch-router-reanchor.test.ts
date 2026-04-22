/**
 * @file tests/agent/dispatch-router-reanchor.test.ts
 * @description Tests for Wave 7D post-dispatch re-anchor callback in dispatch-router.ts.
 *
 * Covers: class-level setter fires per instance; module-level setter fires for all instances;
 * fail-open on throwing callback; undefined clears callback.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DispatchRouter,
  setGlobalDispatchReAnchorCallback,
} from '../../src/core/brain/dispatch-router.js';
import type { DispatchInput } from '../../src/core/brain/dispatch-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    userText: 'Hello there',
    history: [],
    primaryModel: 'grok-3',
    cheapModel: 'grok-3-mini',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchRouter: post-dispatch re-anchor callback (Wave 7D)', () => {
  afterEach(() => {
    // Clear module-level callback between tests
    setGlobalDispatchReAnchorCallback(undefined);
  });

  it('DR-1: class-level setReAnchorCallback fires on route()', () => {
    const cb = vi.fn();
    const router = new DispatchRouter();
    router.setReAnchorCallback(cb);

    router.route(makeInput());

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('DR-2: module-level setGlobalDispatchReAnchorCallback fires on route()', () => {
    const cb = vi.fn();
    setGlobalDispatchReAnchorCallback(cb);
    const router = new DispatchRouter();

    router.route(makeInput());

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('DR-3: both class-level and module-level fire independently', () => {
    const classCb = vi.fn();
    const globalCb = vi.fn();
    setGlobalDispatchReAnchorCallback(globalCb);
    const router = new DispatchRouter();
    router.setReAnchorCallback(classCb);

    router.route(makeInput());

    expect(classCb).toHaveBeenCalledTimes(1);
    expect(globalCb).toHaveBeenCalledTimes(1);
  });

  it('DR-4: fires once per route() call (multiple routes = multiple fires)', () => {
    const cb = vi.fn();
    setGlobalDispatchReAnchorCallback(cb);
    const router = new DispatchRouter();

    router.route(makeInput({ userText: 'Request 1' }));
    router.route(makeInput({ userText: 'Request 2' }));

    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('DR-5: no callback set → route() still works correctly', () => {
    const router = new DispatchRouter();

    const result = router.route(makeInput());

    expect(result).toHaveProperty('model');
    expect(typeof result.noveltyScore).toBe('number');
  });

  it('DR-6: throwing class-level callback does not propagate (fail-open)', () => {
    const cb = vi.fn().mockImplementation(() => { throw new Error('CB exploded'); });
    const router = new DispatchRouter();
    router.setReAnchorCallback(cb);

    expect(() => router.route(makeInput())).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('DR-7: throwing module-level callback does not propagate (fail-open)', () => {
    const cb = vi.fn().mockImplementation(() => { throw new Error('Global CB exploded'); });
    setGlobalDispatchReAnchorCallback(cb);
    const router = new DispatchRouter();

    expect(() => router.route(makeInput())).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('DR-8: setReAnchorCallback(undefined) clears the class-level callback', () => {
    const cb = vi.fn();
    const router = new DispatchRouter();
    router.setReAnchorCallback(cb);
    router.setReAnchorCallback(undefined);

    router.route(makeInput());

    expect(cb).not.toHaveBeenCalled();
  });
});
