/**
 * @file captcha.test.ts
 * @description Real-browser e2e for CAPTCHA detection (Phase 4 #8). Detection only —
 * the tool parks/hands off and never solves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { detectCaptchas } from '../../src/core/tools/builtin/browser/captcha.js';

describe('detectCaptchas (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <div class="g-recaptcha" data-sitekey="x"></div>
      <div class="h-captcha" data-sitekey="y"></div>
      <div class="cf-turnstile" data-sitekey="z"></div>
    `, { waitUntil: 'load' });
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it('detects multiple CAPTCHA types present on the page', async () => {
    const found = (await detectCaptchas(page)).map((d) => d.name);
    expect(found).toContain('reCAPTCHA v2');
    expect(found).toContain('hCaptcha');
    expect(found).toContain('Cloudflare Turnstile');
  });

  it('narrows detection with a type filter', async () => {
    const found = await detectCaptchas(page, 'turnstile');
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Cloudflare Turnstile');
  });

  it('returns empty on a clean page', async () => {
    const clean = await browser.newPage();
    await clean.setContent('<h1>hello</h1>', { waitUntil: 'load' });
    expect(await detectCaptchas(clean)).toHaveLength(0);
    await clean.close();
  });
});
