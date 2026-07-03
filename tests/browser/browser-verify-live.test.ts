/**
 * @file browser-verify-live.test.ts
 * @description Real-browser e2e for the default probe: it inspects the live
 * 'default' browser session and flags an unresolved CAPTCHA at task end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { verifyBrowserTaskCompletion } from '../../src/core/agent/browser-verify.js';
import { BrowserManager } from '../../src/core/tools/builtin/browser/browser-manager.js';
import type { BrowserInstance } from '../../src/core/tools/builtin/browser/browser-manager.js';

describe.skipIf(!browserAvailable())('browser task-end verify (real browser, default probe)', () => {
  let inst: BrowserInstance;

  beforeAll(async () => {
    inst = await BrowserManager.getInstance().launch('default', true);
  }, 40_000);

  afterAll(async () => {
    await BrowserManager.getInstance().close('default').catch(() => {});
  });

  it('passes on a clean page', async () => {
    const page = await inst.context.newPage();
    await page.goto('data:text/html,<h1>All done</h1>', { waitUntil: 'load' });
    const res = await verifyBrowserTaskCompletion();
    expect(res).toEqual({ ok: true });
  }, 30_000);

  it('flags a page left on a real CAPTCHA widget', async () => {
    const page = await inst.context.newPage();
    await page.goto('data:text/html,<div class="h-captcha" data-sitekey="x"></div>', { waitUntil: 'load' });
    const res = await verifyBrowserTaskCompletion();
    expect(res?.ok).toBe(false);
    expect(res?.note).toContain('hCaptcha');
  }, 30_000);
});
