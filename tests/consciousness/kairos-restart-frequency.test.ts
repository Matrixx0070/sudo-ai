/**
 * @file tests/consciousness/kairos-restart-frequency.test.ts
 * @description GW-9 HIGH-1: Kairos restart-FREQUENCY guard. The stale-handoff
 * cooldown only engages on a FAILED handoff; the classic loop (condition-critical
 * → restart → still-critical → restart) has a SUCCESSFUL handoff each time, so it
 * needs a frequency ceiling that trips regardless of handoff success.
 *
 *   FREQ-1  3 restarts within the window → the 4th is suppressed
 *   FREQ-2  after the window elapses → restarts are allowed again
 *   FREQ-3  under the ceiling → not suppressed
 *
 * Uses an injected clock (the exported fns take a `now` arg) and the real record
 * file under data/ (gitignored), reset before/after each case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isKairosRestartFrequencyExceeded,
  recordKairosRestart,
  __resetRestartLogForTest,
  KAIROS_RESTART_MAX_IN_WINDOW,
  KAIROS_RESTART_WINDOW_MS,
} from '../../src/core/consciousness/kairos.js';

describe('Kairos restart-frequency guard (GW-9 HIGH-1)', () => {
  beforeEach(() => { __resetRestartLogForTest(); });
  afterEach(() => { __resetRestartLogForTest(); });

  it('FREQ-1: N restarts within the window suppress the (N+1)th', () => {
    const t0 = 1_000_000;
    // Fire exactly the ceiling number of restarts, all inside the window.
    for (let i = 0; i < KAIROS_RESTART_MAX_IN_WINDOW; i++) {
      recordKairosRestart(t0 + i * 60_000); // 1 min apart
    }
    const nextAttempt = t0 + KAIROS_RESTART_MAX_IN_WINDOW * 60_000;
    // Ceiling reached → the next restart must be suppressed.
    expect(isKairosRestartFrequencyExceeded(nextAttempt)).toBe(true);
  });

  it('FREQ-2: after the window elapses, restarts are allowed again', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < KAIROS_RESTART_MAX_IN_WINDOW; i++) {
      recordKairosRestart(t0 + i * 60_000);
    }
    // Advance past the window relative to the LAST restart → all entries age out.
    const lastAt = t0 + (KAIROS_RESTART_MAX_IN_WINDOW - 1) * 60_000;
    const afterWindow = lastAt + KAIROS_RESTART_WINDOW_MS + 1;
    expect(isKairosRestartFrequencyExceeded(afterWindow)).toBe(false);
  });

  it('FREQ-3: below the ceiling is not suppressed', () => {
    const t0 = 3_000_000;
    // One fewer than the ceiling.
    for (let i = 0; i < KAIROS_RESTART_MAX_IN_WINDOW - 1; i++) {
      recordKairosRestart(t0 + i * 1000);
    }
    expect(isKairosRestartFrequencyExceeded(t0 + KAIROS_RESTART_MAX_IN_WINDOW * 1000)).toBe(false);
  });

  it('FREQ-4: entries older than the window do not count toward the ceiling', () => {
    const t0 = 4_000_000;
    // Two stale restarts far in the past + one recent → recent count = 1 < ceiling.
    recordKairosRestart(t0);
    recordKairosRestart(t0 + 1000);
    const now = t0 + KAIROS_RESTART_WINDOW_MS + 10 * 60_000;
    recordKairosRestart(now);
    expect(isKairosRestartFrequencyExceeded(now)).toBe(false);
  });
});
