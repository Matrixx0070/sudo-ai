/**
 * @file recovery-settle.test.ts
 * @description captureFreshSnapshot (recovery) must let a transitioning page settle
 * before stamping refs — the weakness the hardened prod run exposed ("(no actionable
 * elements found)" when the failed click had started a navigation).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import { captureFreshSnapshot } from '../../src/core/agent/browser-recovery.js';

describe.skipIf(!browserAvailable())('captureFreshSnapshot settle (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it('returns refs on an already-rendered page', async () => {
    await page.setContent('<button>Ready Button</button>', { waitUntil: 'load' });
    const render = await captureFreshSnapshot(page);
    expect(render).toContain('Ready Button');
    expect(render).toMatch(/\[\d+\] /);
  }, 20_000);

  it('retries after a settle when the page has no actionable content yet', async () => {
    // Empty at capture time; content injected AFTER the first capture but before the
    // 600ms retry — so only the settle+retry path recovers usable refs.
    await page.setContent(
      '<div id="root"></div><script>setTimeout(function(){document.getElementById("root").innerHTML="<button>Late Button</button>";}, 400)</script>',
      { waitUntil: 'load' },
    );
    const render = await captureFreshSnapshot(page);
    expect(render).toContain('Late Button');
  }, 20_000);
});
