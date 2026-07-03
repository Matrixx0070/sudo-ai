/**
 * @file captcha.ts
 * @description browser.captcha — detect CAPTCHA presence on the current page
 * and log it. This is a stub that identifies common CAPTCHA patterns without
 * solving them. Extend with a 3rd-party solver API when needed.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';

// Known CAPTCHA selectors / URL patterns
const CAPTCHA_SIGNATURES = [
  { name: 'reCAPTCHA v2',  selector: '.g-recaptcha, iframe[src*="recaptcha"]' },
  { name: 'reCAPTCHA v3',  selector: 'script[src*="recaptcha/api.js"]' },
  { name: 'hCaptcha',      selector: '.h-captcha, iframe[src*="hcaptcha"]' },
  { name: 'Cloudflare',    selector: 'form#challenge-form, #cf-challenge-running' },
  { name: 'FunCaptcha',    selector: 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]' },
  { name: 'GeeTest',       selector: '.geetest_wrap, .geetest_holder' },
];

export const captchaTool: ToolDefinition = {
  name: 'browser.captcha',
  description:
    'Detect CAPTCHA presence on the current browser page. Identifies reCAPTCHA, hCaptcha, ' +
    'Cloudflare, FunCaptcha, and GeeTest patterns. Logs detection and returns type. ' +
    'Note: automatic solving requires a 3rd-party API key — currently a detection stub only.',
  category: 'browser',
  timeout: 15_000,
  parameters: {
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    type: {
      type: 'string',
      required: false,
      description: 'Narrow detection to a specific CAPTCHA type (optional).',
    },
    apiKey: {
      type: 'string',
      required: false,
      description: 'Reserved for future solver API integration. Currently unused.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const typeFilter = typeof params['type'] === 'string' ? params['type'].toLowerCase() : null;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const page = await resolveActivePage(instance);

    try {
      const detected: Array<{ name: string; selector: string }> = [];
      const signatures = typeFilter
        ? CAPTCHA_SIGNATURES.filter((s) => s.name.toLowerCase().includes(typeFilter))
        : CAPTCHA_SIGNATURES;

      for (const sig of signatures) {
        const count = await page.locator(sig.selector).count().catch(() => 0);
        if (count > 0) {
          detected.push({ name: sig.name, selector: sig.selector });
        }
      }

      const hasCaptcha = detected.length > 0;
      const pageUrl = page.url();

      if (hasCaptcha) {
        ctxLog.warn(
          { tool: 'browser.captcha', url: pageUrl, detected: detected.map((d) => d.name) },
          'CAPTCHA detected — human intervention may be required',
        );
      } else {
        ctxLog.info({ tool: 'browser.captcha', url: pageUrl }, 'No CAPTCHA detected');
      }

      return {
        success: true,
        output: hasCaptcha
          ? `CAPTCHA detected on ${pageUrl}: ${detected.map((d) => d.name).join(', ')}. Manual solving required.`
          : `No CAPTCHA detected on ${pageUrl}.`,
        data: { hasCaptcha, detected, url: pageUrl },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.captcha', err }, 'CAPTCHA detection failed');
      return { success: false, output: `browser.captcha error: ${msg}` };
    }
  },
};
