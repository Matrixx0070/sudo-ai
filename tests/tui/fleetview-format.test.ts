/**
 * @file tests/tui/fleetview-format.test.ts
 * @description Pure formatter tests for the FleetView TUI (gap #25 slice 2).
 */

import { describe, it, expect } from 'vitest';
import { clipTask, formatElapsed, shortId, summaryLine } from '../../src/tui/fleetview/format.js';

describe('formatElapsed', () => {
  it('returns "-" for non-finite or negative input', () => {
    expect(formatElapsed(NaN)).toBe('-');
    expect(formatElapsed(-1)).toBe('-');
    expect(formatElapsed(Infinity)).toBe('-');
  });

  it('formats sub-second as ms', () => {
    expect(formatElapsed(0)).toBe('0ms');
    expect(formatElapsed(999)).toBe('999ms');
  });

  it('formats seconds < 60', () => {
    expect(formatElapsed(1_000)).toBe('1s');
    expect(formatElapsed(59_500)).toBe('59s');
  });

  it('formats minutes with zero-padded seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(125_000)).toBe('2m05s');
  });

  it('formats hours with zero-padded minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m');
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe('1h05m');
  });
});

describe('shortId', () => {
  it('returns the id unchanged when shorter than prefixLen', () => {
    expect(shortId('abc', 8)).toBe('abc');
  });

  it('truncates to prefixLen', () => {
    expect(shortId('abcdefghij', 4)).toBe('abcd');
  });

  it('returns "" for empty id', () => {
    expect(shortId('', 8)).toBe('');
  });
});

describe('clipTask', () => {
  it('returns the task unchanged when within length', () => {
    expect(clipTask('short', 10)).toBe('short');
  });

  it('appends an ellipsis on truncation', () => {
    expect(clipTask('x'.repeat(20), 5)).toBe('xxxx…');
  });

  it('returns "" for empty input', () => {
    expect(clipTask('', 5)).toBe('');
  });
});

describe('summaryLine', () => {
  it('renders the expected layout', () => {
    expect(
      summaryLine({ slotsUsed: 2, slotsMax: 4, queueWaiting: 1, idleCount: 0 }),
    ).toBe('slots 2/4  queued 1  idle 0');
  });
});
