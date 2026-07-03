/**
 * @file browser-verify.test.ts
 * @description Unit tests for task-end browser verification (injected probe).
 */
import { describe, it, expect } from 'vitest';
import {
  verifyBrowserTaskCompletion,
  isBrowserVerifyEnabled,
} from '../../src/core/agent/browser-verify.js';

describe('verifyBrowserTaskCompletion', () => {
  it('returns null when there is no browser session', async () => {
    expect(await verifyBrowserTaskCompletion(async () => null)).toBeNull();
  });

  it('passes when the active page is clean', async () => {
    const res = await verifyBrowserTaskCompletion(async () => ({ url: 'https://example.com/done', captchas: [] }));
    expect(res).toEqual({ ok: true });
  });

  it('flags an unresolved CAPTCHA left on the page', async () => {
    const res = await verifyBrowserTaskCompletion(async () => ({ url: 'https://site/login', captchas: ['hCaptcha'] }));
    expect(res?.ok).toBe(false);
    expect(res?.note).toContain('hCaptcha');
    expect(res?.note).toContain('https://site/login');
    expect(res?.note).toContain('[BROWSER VERIFY]');
  });

  it('flags a chrome error page', async () => {
    const res = await verifyBrowserTaskCompletion(async () => ({ url: 'chrome-error://chromewebdata/', captchas: [] }));
    expect(res?.ok).toBe(false);
    expect(res?.note).toMatch(/error page/i);
  });

  it('fails open (probe throws) → null', async () => {
    expect(await verifyBrowserTaskCompletion(async () => { throw new Error('boom'); })).toBeNull();
  });

  it('kill-switch: enabled only under SUDO_BROWSER_VERIFY=1', () => {
    expect(isBrowserVerifyEnabled({ SUDO_BROWSER_VERIFY: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isBrowserVerifyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
