/**
 * @file tests/operators/scheduler.test.ts
 * @description Tests for OperatorScheduler — Wave 10 operator scheduling.
 *
 * Tests:
 *  1.  registerAll() with empty array → count is 0
 *  2.  registerAll() with 2 enabled operators → count is 2
 *  3.  disabled operator is skipped by registerAll()
 *  4.  interval operator fires after delay
 *  5.  cron operator registered without error
 *  6.  shutdown() clears all registered operators
 *  7.  activeNames() returns names of active operators
 *  8.  interval with invalid value (NaN) → operator skipped
 *  9.  interval with string value (numeric string) → parsed correctly
 *  10. fire callback error → does not crash the scheduler
 *  11. multiple fires of same operator → callback called multiple times
 *  12. register() individual manifest works independently
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OperatorScheduler } from '../../src/core/operators/operator-scheduler.js';
import type { OperatorManifest } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<OperatorManifest> = {}): OperatorManifest {
  return {
    name: 'test-op',
    version: '1.0.0',
    description: 'Test operator',
    enabled: true,
    agent: { max_turns: 3, temperature: 0.5 },
    schedule: { type: 'interval', value: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OperatorScheduler', () => {
  it('1. registerAll with empty array → count is 0', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.registerAll([]);
    expect(scheduler.count).toBe(0);
    scheduler.shutdown();
  });

  it('2. registerAll with 2 enabled operators → count is 2', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.registerAll([
      makeManifest({ name: 'op1' }),
      makeManifest({ name: 'op2' }),
    ]);
    expect(scheduler.count).toBe(2);
    scheduler.shutdown();
  });

  it('3. disabled operator skipped by registerAll', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.registerAll([
      makeManifest({ name: 'enabled-op', enabled: true }),
      makeManifest({ name: 'disabled-op', enabled: false }),
    ]);
    expect(scheduler.count).toBe(1);
    expect(scheduler.activeNames()).toContain('enabled-op');
    expect(scheduler.activeNames()).not.toContain('disabled-op');
    scheduler.shutdown();
  });

  it('4. interval operator fires after delay', async () => {
    const callback = vi.fn();
    const scheduler = new OperatorScheduler(callback);
    scheduler.register(makeManifest({ schedule: { type: 'interval', value: 2 } }));

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.shutdown();
  });

  it('5. cron operator registered without error', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    expect(() => {
      scheduler.register(makeManifest({ schedule: { type: 'cron', value: '0 9 * * *' } }));
    }).not.toThrow();
    expect(scheduler.count).toBe(1);
    scheduler.shutdown();
  });

  it('6. shutdown() clears all registered operators', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.registerAll([
      makeManifest({ name: 'op1' }),
      makeManifest({ name: 'op2' }),
    ]);
    expect(scheduler.count).toBe(2);
    scheduler.shutdown();
    expect(scheduler.count).toBe(0);
  });

  it('7. activeNames() returns names of all active operators', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.registerAll([
      makeManifest({ name: 'alpha' }),
      makeManifest({ name: 'beta' }),
    ]);
    const names = scheduler.activeNames();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    scheduler.shutdown();
  });

  it('8. interval with invalid value → operator skipped', () => {
    const scheduler = new OperatorScheduler(vi.fn());
    scheduler.register(makeManifest({ schedule: { type: 'interval', value: 'not-a-number' } }));
    expect(scheduler.count).toBe(0);
    scheduler.shutdown();
  });

  it('9. interval with numeric string value → parsed correctly', () => {
    const callback = vi.fn();
    const scheduler = new OperatorScheduler(callback);
    // value as string "3" should parse to 3 seconds
    scheduler.register(makeManifest({ schedule: { type: 'interval', value: '3' } }));
    expect(scheduler.count).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledTimes(1);
    scheduler.shutdown();
  });

  it('10. fire callback error does not crash scheduler', () => {
    const throwingCallback = vi.fn(() => { throw new Error('callback error'); });
    const scheduler = new OperatorScheduler(throwingCallback);
    scheduler.register(makeManifest({ name: 'error-op', schedule: { type: 'interval', value: 1 } }));

    expect(() => {
      vi.advanceTimersByTime(1000);
    }).not.toThrow();

    expect(throwingCallback).toHaveBeenCalled();
    scheduler.shutdown();
  });

  it('11. multiple fires of same operator → callback called multiple times', () => {
    const callback = vi.fn();
    const scheduler = new OperatorScheduler(callback);
    scheduler.register(makeManifest({ schedule: { type: 'interval', value: 1 } }));

    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(5);
    scheduler.shutdown();
  });

  it('12. register() individual manifest works independently', () => {
    const callback = vi.fn();
    const scheduler = new OperatorScheduler(callback);
    const manifest = makeManifest({ name: 'solo-op', schedule: { type: 'interval', value: 1 } });
    scheduler.register(manifest);
    expect(scheduler.count).toBe(1);
    expect(scheduler.activeNames()).toEqual(['solo-op']);
    scheduler.shutdown();
  });
});
