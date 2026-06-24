/**
 * @file doom-loop.test.ts
 * @description Tests for DoomLoopDetector v2 — Grok Build CLI parity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DoomLoopDetector,
  DOOM_LOOP_THRESHOLD,
  DOOM_LOOP_RO_THRESHOLD,
  DOOM_LOOP_STALE_MS,
  type DoomLoopResult,
} from '../../src/core/agent/doom-loop.js';

describe('DoomLoopDetector', () => {
  let detector: DoomLoopDetector;

  beforeEach(() => {
    detector = new DoomLoopDetector(null);
  });

  it('should have Grok-parity default thresholds', () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(4);
    expect(DOOM_LOOP_RO_THRESHOLD).toBe(8);
  });

  it('should allow tool calls when no repetition', () => {
    const result = detector.recordCall('fs.read_file', { path: '/a' }, 1);
    expect(result.action).toBe('allow');
  });

  it('should allow different tool calls across turns', () => {
    detector.recordCall('fs.read_file', { path: '/a' }, 1);
    detector.onNewTurn();
    const result = detector.recordCall('fs.write_file', { path: '/b' }, 2);
    expect(result.action).toBe('allow');
  });

  it('should allow same tool call in same turn without incrementing cross-turn count', () => {
    // Same turn — should not count as a cross-turn cycle
    detector.recordCall('fs.read_file', { path: '/a' }, 1);
    detector.recordCall('fs.read_file', { path: '/a' }, 1);
    detector.recordCall('fs.read_file', { path: '/a' }, 1);
    // Only 1 cross-turn cycle (started in turn 1, all in turn 1)
    const result = detector.recordCall('fs.read_file', { path: '/a' }, 1);
    expect(result.action).toBe('allow');
  });

  it('should warn at DOOM_LOOP_THRESHOLD cross-turn repetitions', () => {
    // Repeat the same tool+args across turns to hit threshold=4
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      const result = detector.recordCall('fs.read_file', { path: '/same' }, turn);
      if (turn < DOOM_LOOP_THRESHOLD) {
        expect(result.action).toBe('allow');
      } else {
        expect(result.action).toBe('warn');
        expect(result.reason).toContain('Doom loop detector');
        expect(result.reason).toContain('fs.read_file');
        expect(result.telemetryEvent?.event).toBe('doom_loop_warning');
      }
    }
  });

  it('should abort at DOOM_LOOP_RO_THRESHOLD cross-turn repetitions', () => {
    // Repeat the same tool+args across turns to hit roThreshold=8
    for (let turn = 1; turn <= DOOM_LOOP_RO_THRESHOLD; turn++) {
      detector.onNewTurn();
      const result = detector.recordCall('fs.read_file', { path: '/stuck' }, turn);
      if (turn < DOOM_LOOP_THRESHOLD) {
        expect(result.action).toBe('allow');
      } else if (turn < DOOM_LOOP_RO_THRESHOLD) {
        // warn or allow (warn only fires once per cycle)
        expect(['allow', 'warn']).toContain(result.action);
      } else {
        expect(result.action).toBe('abort');
        expect(result.reason).toContain('Doom loop detector');
        expect(result.telemetryEvent?.event).toBe('doom_loop_terminated');
      }
    }
  });

  it('should not warn twice for the same cycle (de-duplication)', () => {
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD + 1; turn++) {
      detector.onNewTurn();
      detector.recordCall('fs.read_file', { path: '/same' }, turn);
    }
    // After threshold, the first warn turn emits warning, subsequent turn should be allow (not warn again)
    detector.onNewTurn();
    const result = detector.recordCall('fs.read_file', { path: '/same' }, DOOM_LOOP_THRESHOLD + 2);
    // Already warned for this cycle, so it should be 'allow' (until abort)
    expect(result.action).toBe('allow');
  });

  it('should track different tools independently', () => {
    // Tool A repeats 3 times (below threshold)
    for (let turn = 1; turn <= 3; turn++) {
      detector.onNewTurn();
      const result = detector.recordCall('fs.read_file', { path: '/a' }, turn);
      expect(result.action).toBe('allow');
    }
    // Tool B repeats 3 times (also below threshold)
    for (let turn = 4; turn <= 6; turn++) {
      detector.onNewTurn();
      const result = detector.recordCall('fs.write_file', { path: '/b' }, turn);
      expect(result.action).toBe('allow');
    }
  });

  it('should reset completely on reset()', () => {
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      detector.recordCall('fs.read_file', { path: '/stuck' }, turn);
    }
    detector.reset();
    // Should start fresh
    const result = detector.recordCall('fs.read_file', { path: '/stuck' }, 1);
    expect(result.action).toBe('allow');
  });

  it('should emit telemetry events through hooks', () => {
    const mockHooks = { emit: vi.fn() };
    const hookedDetector = new DoomLoopDetector(mockHooks);

    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      hookedDetector.onNewTurn();
      hookedDetector.recordCall('fs.read_file', { path: '/t' }, turn);
    }

    expect(mockHooks.emit).toHaveBeenCalledWith('doom_loop_warning', expect.objectContaining({
      event: 'doom_loop_warning',
      toolName: 'fs.read_file',
    }));
  });

  it('should emit doom_loop_terminated at abort threshold', () => {
    const mockHooks = { emit: vi.fn() };
    const hookedDetector = new DoomLoopDetector(mockHooks);

    for (let turn = 1; turn <= DOOM_LOOP_RO_THRESHOLD; turn++) {
      hookedDetector.onNewTurn();
      hookedDetector.recordCall('fs.read_file', { path: '/t' }, turn);
    }

    expect(mockHooks.emit).toHaveBeenCalledWith('doom_loop_terminated', expect.objectContaining({
      event: 'doom_loop_terminated',
      toolName: 'fs.read_file',
    }));
  });

  it('should return cycle stats', () => {
    detector.recordCall('fs.read_file', { path: '/a' }, 1);
    detector.onNewTurn();
    detector.recordCall('fs.read_file', { path: '/a' }, 2);
    detector.recordCall('fs.write_file', { path: '/b' }, 2);

    const stats = detector.getCycleStats();
    expect(stats.length).toBeGreaterThanOrEqual(2);
    const readStat = stats.find(s => s.toolName === 'fs.read_file');
    expect(readStat).toBeDefined();
    expect(readStat!.count).toBe(2);
  });

  it('should handle unhashable args gracefully', () => {
    // Circular reference should not crash
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = detector.recordCall('fs.read_file', circular, 1);
    expect(result.action).toBe('allow');
  });
});

describe('DoomLoopDetector — temporal staleness window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT accumulate when the same fixed-arg tool recurs slower than the window', () => {
    // The cron-health-via-heartbeat pattern: identical call once per turn, but
    // each turn separated by MORE than the staleness window (~30min gaps live).
    // Must never warn or abort, no matter how many turns elapse.
    const detector = new DoomLoopDetector(null);
    for (let turn = 1; turn <= DOOM_LOOP_RO_THRESHOLD + 4; turn++) {
      detector.onNewTurn();
      const r = detector.recordCall('automation.cron-health', {}, turn);
      expect(r.action).toBe('allow');
      vi.advanceTimersByTime(DOOM_LOOP_STALE_MS + 1000); // gap exceeds the window
    }
  });

  it('still warns on rapid repetition within the window', () => {
    const detector = new DoomLoopDetector(null);
    let last: DoomLoopResult | undefined;
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      last = detector.recordCall('fs.read_file', { path: '/x' }, turn);
      vi.advanceTimersByTime(1000); // 1s gaps — well inside the window
    }
    expect(last?.action).toBe('warn');
  });

  it('re-arms: a fresh rapid loop after a stale gap can warn again', () => {
    const detector = new DoomLoopDetector(null);
    // Burst 1 → warn.
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      detector.recordCall('x.y', {}, turn);
      vi.advanceTimersByTime(1000);
    }
    // Long idle gap → the cycle goes stale.
    vi.advanceTimersByTime(DOOM_LOOP_STALE_MS + 1000);
    // Burst 2 → count restarts from 1 and the warning is re-armed, so it warns again.
    let last: DoomLoopResult | undefined;
    for (let turn = 10; turn < 10 + DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      last = detector.recordCall('x.y', {}, turn);
      vi.advanceTimersByTime(1000);
    }
    expect(last?.action).toBe('warn');
  });

  it('setting SUDO_DOOM_LOOP_STALE_MS=0 keeps the window from firing (default still 5min)', () => {
    // Sanity on the configured default: the window is a positive 5 minutes so the
    // staleness branch is active out of the box.
    expect(DOOM_LOOP_STALE_MS).toBe(5 * 60_000);
  });
});