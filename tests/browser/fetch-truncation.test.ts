/**
 * @file tests/browser/fetch-truncation.test.ts
 * @description Tests for browser.fetch truncation — raised cap + a loud,
 *   top-of-output warning so the model won't confabulate a "latest X" answer
 *   from a truncated list (the Node.js-LTS misparse root cause).
 */

import { describe, it, expect } from 'vitest';
import { applyFetchTruncation } from '../../src/core/tools/builtin/browser/fetch-url.js';

describe('applyFetchTruncation', () => {
  it('returns the body unchanged when under the cap', () => {
    const body = 'short body';
    expect(applyFetchTruncation(body, 20_000)).toBe(body);
  });

  it('truncates to maxLength and keeps the head content', () => {
    const body = 'A'.repeat(30_000);
    const out = applyFetchTruncation(body, 20_000);
    expect(out).toContain('A'.repeat(20_000));
    expect(out).not.toContain('A'.repeat(20_001));
  });

  it('places the loud INCOMPLETE warning at the very top (survives head-clamp)', () => {
    const out = applyFetchTruncation('B'.repeat(30_000), 20_000);
    expect(out.startsWith('⚠️ TRUNCATED RESPONSE')).toBe(true);
    // A downstream head-clamp keeps the start — the warning is in it.
    expect(out.slice(0, 300)).toMatch(/INCOMPLETE/);
    expect(out.slice(0, 300)).toMatch(/do NOT treat them as missing|latest\/newest\/last/);
  });

  it('reports exact total and omitted counts', () => {
    const out = applyFetchTruncation('C'.repeat(25_000), 20_000);
    expect(out).toContain('first 20000 of 25000');
    expect(out).toContain('5000 omitted');
    expect(out).toMatch(/\[truncated — 25000 total chars, 5000 omitted/);
  });

  it('the raised 20K default would have exposed the Node LTS entry (char 8597)', () => {
    // The real failure: the first LTS entry sat at char ~8597 in a 325KB list,
    // truncated off by the old 8000 cap. 20000 > 8597 → now visible.
    const body = 'x'.repeat(8_596) + 'FIRST_LTS_ENTRY' + 'y'.repeat(300_000);
    const out = applyFetchTruncation(body, 20_000);
    expect(out).toContain('FIRST_LTS_ENTRY');
  });
});
