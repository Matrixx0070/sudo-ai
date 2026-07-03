/**
 * @file resilience.test.ts
 * @description Unit + real-browser e2e for the self-heal primitives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  withRetry,
  isRetryableError,
  robustFill,
  configuredAttempts,
} from '../../src/core/tools/builtin/browser/resilience.js';

describe('withRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('Timeout 5000ms exceeded');
      return 'ok';
    }, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows immediately on a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('strict mode violation: bad selector'); }, { baseDelayMs: 1 }),
    ).rejects.toThrow('strict mode');
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('Timeout exceeded'); }, { attempts: 4, baseDelayMs: 1 }),
    ).rejects.toThrow('Timeout');
    expect(calls).toBe(4);
  });

  it('isRetryableError classifies known transient messages', () => {
    expect(isRetryableError(new Error('Timeout 30000ms exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Element is not visible'))).toBe(true);
    expect(isRetryableError(new Error('Execution context was destroyed'))).toBe(true);
    expect(isRetryableError(new Error('strict mode violation'))).toBe(false);
  });

  it('configuredAttempts honors the kill-switch', () => {
    const prev = process.env['SUDO_BROWSER_RETRY'];
    process.env['SUDO_BROWSER_RETRY'] = '0';
    expect(configuredAttempts()).toBe(1);
    if (prev === undefined) delete process.env['SUDO_BROWSER_RETRY'];
    else process.env['SUDO_BROWSER_RETRY'] = prev;
    expect(configuredAttempts()).toBeGreaterThanOrEqual(1);
  });
});

describe('robustFill (real browser)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <input id="plain" />
      <div id="rich" contenteditable="true"></div>
    `, { waitUntil: 'load' });
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it('fills a plain input via fill()', async () => {
    const res = await robustFill(page.locator('#plain'), 'hello world');
    expect(res.method).toBe('fill');
    expect(await page.inputValue('#plain')).toBe('hello world');
  });

  it('fills a contenteditable via sequential entry (fill() would no-op)', async () => {
    const res = await robustFill(page.locator('#rich'), 'rich text');
    expect(res.method).toBe('sequential');
    expect(await page.textContent('#rich')).toBe('rich text');
  });
});
