/**
 * @file active-page.test.ts
 * @description Real-browser e2e for the unified active-page resolver. Proves the
 * multi-tab correctness bug is fixed: an explicit switch changes which page the
 * tools act on, newly-opened tabs/popups auto-become active (preserving old
 * "newest page" behaviour), and closing the active page falls back cleanly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { resolveActivePage, setActivePage } from '../../src/core/tools/builtin/browser/active-page.js';
import type { BrowserInstance } from '../../src/core/tools/builtin/browser/browser-manager.js';

describe.skipIf(!browserAvailable())('active-page resolver (real browser)', () => {
  let browser: Browser;
  let context: BrowserContext;
  const inst = () => ({ context } as unknown as BrowserInstance);

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('falls back to the newest page when nothing is tracked', async () => {
    const p1 = await context.newPage();
    const p2 = await context.newPage();
    // First resolve: no explicit active page tracked yet → newest (p2).
    expect(await resolveActivePage(inst())).toBe(p2);
    void p1;
  });

  it('explicit switch changes the acted-on page (the fixed bug)', async () => {
    const pages = context.pages();
    const first = pages[0]!;
    // Simulate browser.tabs switch to an EARLIER tab.
    setActivePage(context, first);
    expect(await resolveActivePage(inst())).toBe(first);
  });

  it('newly-opened tab/popup auto-becomes active (preserves newest-page behaviour)', async () => {
    // Tracking listener is attached after the first resolveActivePage above.
    const p3 = await context.newPage();
    // Give the context 'page' event a tick to fire.
    await p3.waitForLoadState('domcontentloaded').catch(() => {});
    expect(await resolveActivePage(inst())).toBe(p3);
  });

  it('closing the active page falls back to another open page', async () => {
    const active = await resolveActivePage(inst());
    await active.close();
    const next = await resolveActivePage(inst());
    expect(next.isClosed()).toBe(false);
    expect(next).not.toBe(active);
  });
});
