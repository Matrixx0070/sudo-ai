/**
 * @file wait-deep-text.test.ts
 * @description browser.wait's text match now pierces iframes and shadow DOM
 * (Phase 1 #3). Verifies the deep search finds text the old body-only check missed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import { pageContainsTextDeep } from '../../src/core/tools/builtin/browser/wait.js';

describe.skipIf(!browserAvailable())('pageContainsTextDeep (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <div id="light">visible light-dom text</div>
      <div id="host"></div>
      <iframe srcdoc="<p>text inside the iframe</p>"></iframe>
      <script>
        const h = document.getElementById('host');
        const root = h.attachShadow({ mode: 'open' });
        root.innerHTML = '<span>secret shadow text</span>';
      </script>
    `, { waitUntil: 'load' });
    await page.waitForTimeout(100);
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it('finds light-DOM text', async () => {
    expect(await pageContainsTextDeep(page, 'visible light-dom text')).toBe(true);
  });

  it('finds text inside an open shadow root', async () => {
    expect(await pageContainsTextDeep(page, 'secret shadow text')).toBe(true);
  });

  it('finds text inside an iframe', async () => {
    expect(await pageContainsTextDeep(page, 'text inside the iframe')).toBe(true);
  });

  it('returns false for absent text', async () => {
    expect(await pageContainsTextDeep(page, 'this string is nowhere')).toBe(false);
  });
});
