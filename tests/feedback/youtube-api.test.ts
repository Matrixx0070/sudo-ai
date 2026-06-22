/**
 * Tests for parseDuration — ISO-8601 duration → seconds. Locks in behavior after
 * adding explicit base-10 radix to its parseInt calls.
 */

import { describe, it, expect } from 'vitest';
import { parseDuration } from '../../src/core/feedback/youtube-api.js';

describe('parseDuration', () => {
  it.each([
    ['PT1H2M3S', 3723],
    ['PT2M3S', 123],
    ['PT45S', 45],
    ['PT1H', 3600],
    ['PT10M', 600],
    ['PT0S', 0],
  ])('parses %s -> %d seconds', (iso, secs) => {
    expect(parseDuration(iso)).toBe(secs);
  });

  it('returns 0 for an unparseable / empty string', () => {
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('not-a-duration')).toBe(0);
  });

  it('parses values with leading zeros as base 10 (not octal)', () => {
    // The radix fix guards against any future octal-ish interpretation.
    expect(parseDuration('PT08M09S')).toBe(8 * 60 + 9);
  });
});
