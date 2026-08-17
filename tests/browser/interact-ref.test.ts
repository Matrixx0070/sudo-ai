/**
 * @file interact-ref.test.ts
 * @description browser.interact must resolve stable refs, not choke on them.
 *
 * Measured from the daemon error logs (2026-08-17): browser.interact failed
 * ~60% of the time (91 calls, EMA 0.39). The dominant cause was the model
 * feeding browser.snapshot's `ref=N` handles into the `selector` field —
 * `[ref=67]`, `[ref="4"]`, `button[ref="5"]`, `[5]`, `ref=67` — none valid CSS,
 * so Playwright threw a SyntaxError or timed out. `extractRefFromSelector`
 * recovers those; this pins the exact strings from the logs.
 */

import { describe, it, expect } from 'vitest';
import { extractRefFromSelector } from '../../src/core/tools/builtin/browser/interact.js';

describe('extractRefFromSelector — recovers refs the model wrote as selectors', () => {
  it('recovers every malformed ref form seen in the failure logs', () => {
    // Exact strings pulled from the daemon error logs.
    expect(extractRefFromSelector('[ref=67]')).toBe(67);
    expect(extractRefFromSelector('[ref="4"]')).toBe(4);
    expect(extractRefFromSelector("[ref='4']")).toBe(4);
    expect(extractRefFromSelector('button[ref="5"]')).toBe(5);
    expect(extractRefFromSelector('div[ref=12]')).toBe(12);
    expect(extractRefFromSelector('[5]')).toBe(5);
    expect(extractRefFromSelector('ref=67')).toBe(67);
    expect(extractRefFromSelector('  [ref=8]  ')).toBe(8); // tolerates whitespace
  });

  it('does NOT misread a legitimate CSS selector as a ref', () => {
    // Over-eager coercion would break real selectors — worse than the bug.
    for (const css of [
      'button[name="Reject All"]',
      'button:has-text("Accept all")',
      '.cookie-banner .accept',
      '#submit',
      'input[type="email"]',
      '[data-ref="widget"]',       // attribute happens to contain "ref"
      'a[href="/login"]',
      'div > span.label',
      'button[aria-label="Close"]',
    ]) {
      expect(extractRefFromSelector(css), css).toBeNull();
    }
  });

  it('returns null for empty / missing input', () => {
    expect(extractRefFromSelector(null)).toBeNull();
    expect(extractRefFromSelector('')).toBeNull();
    expect(extractRefFromSelector('   ')).toBeNull();
  });
});
