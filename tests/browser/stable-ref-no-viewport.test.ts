/**
 * @file stable-ref-no-viewport.test.ts
 * @description Regression for the prod bug: a headless/CDP browser with no real
 * viewport makes getBoundingClientRect() return 0 for every element, so gating
 * visibility on rect size filtered out the WHOLE page (refCount 0 on real pages
 * like Wikipedia, while ariaSnapshot still saw 1655 lines). captureStableRefs must
 * rely on checkVisibility (layout-independent), not element size.
 *
 * We reproduce the condition deterministically by forcing getBoundingClientRect to
 * return zeros, then assert refs are still stamped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import { captureStableRefs } from '../../src/core/tools/builtin/browser/stable-ref.js';

describe.skipIf(!browserAvailable())('stable refs with a zero-size viewport (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <button id="b1">Visible Btn</button>
      <a href="/x" id="a1">A Link</a>
      <div style="display:none"><button>Hidden Btn</button></div>
    `, { waitUntil: 'load' });
    // Simulate the viewport-less browser: every rect is zero-sized.
    await page.evaluate(() => {
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() { return {}; } }),
      });
    });
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it('still stamps visible elements when all rects are zero (checkVisibility decisive)', async () => {
    const cap = await captureStableRefs(page);
    // With the old rect-size gate this was 0. Now the genuinely-visible elements
    // are found via checkVisibility despite zero rects.
    expect(cap.refs.length).toBeGreaterThanOrEqual(2);
    const names = cap.refs.map((r) => r.name);
    expect(names).toContain('Visible Btn');
    expect(names).toContain('A Link');
    // display:none is still excluded (checkVisibility = false).
    expect(names).not.toContain('Hidden Btn');
  }, 20_000);
});
