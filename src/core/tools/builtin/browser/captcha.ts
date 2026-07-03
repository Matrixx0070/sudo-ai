/**
 * @file captcha.ts
 * @description browser.captcha — detect a CAPTCHA / bot-wall on the current page
 * and hand off to the operator. This tool DETECTS and PARKS; it deliberately does
 * NOT solve CAPTCHAs. Defeating a third-party site's anti-abuse challenge is out of
 * scope by design (see docs/browser-autonomy-campaign.md, "Non-goal").
 *
 * Autonomous behaviour: on detection, when running unattended, it emits a proactive
 * notification so the operator can step in (or complete the challenge in the shared
 * session), and returns a structured "parked" result the agent can act on — instead
 * of silently looping against a wall.
 */

import type { Page } from 'playwright-core';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { unattendedEnabled } from './autonomy.js';
import { notify } from '../../../awareness/proactive-notifier.js';

/** Known CAPTCHA / bot-wall signatures. Detection only. */
export const CAPTCHA_SIGNATURES: ReadonlyArray<{ name: string; selector: string }> = [
  { name: 'reCAPTCHA v2',         selector: '.g-recaptcha, iframe[src*="recaptcha"]' },
  { name: 'reCAPTCHA v3',         selector: 'script[src*="recaptcha/api.js"]' },
  { name: 'hCaptcha',             selector: '.h-captcha, iframe[src*="hcaptcha"]' },
  { name: 'Cloudflare Turnstile', selector: '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]' },
  { name: 'Cloudflare Challenge', selector: 'form#challenge-form, #cf-challenge-running' },
  { name: 'Friendly Captcha',     selector: '.frc-captcha, [data-sitekey].frc-captcha' },
  { name: 'FunCaptcha',           selector: 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]' },
  { name: 'GeeTest',              selector: '.geetest_wrap, .geetest_holder' },
];

export interface CaptchaDetection {
  name: string;
  selector: string;
}

/**
 * Detect known CAPTCHA/bot-wall signatures on a page. Pure — no side effects.
 * Optionally narrowed to a single type substring.
 */
export async function detectCaptchas(page: Page, typeFilter?: string | null): Promise<CaptchaDetection[]> {
  const sigs = typeFilter
    ? CAPTCHA_SIGNATURES.filter((s) => s.name.toLowerCase().includes(typeFilter.toLowerCase()))
    : CAPTCHA_SIGNATURES;

  const detected: CaptchaDetection[] = [];
  for (const sig of sigs) {
    const count = await page.locator(sig.selector).count().catch(() => 0);
    if (count > 0) detected.push({ name: sig.name, selector: sig.selector });
  }
  return detected;
}

export const captchaTool: ToolDefinition = {
  name: 'browser.captcha',
  description:
    'Detect a CAPTCHA or bot-wall on the current browser page (reCAPTCHA v2/v3, hCaptcha, ' +
    'Cloudflare Turnstile/Challenge, Friendly Captcha, FunCaptcha, GeeTest). This tool DETECTS ' +
    'and hands off to the operator — it does not solve challenges. On detection it parks the task ' +
    'and (when unattended) notifies the operator.',
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
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const typeFilter = typeof params['type'] === 'string' ? params['type'] : null;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    const page = await resolveActivePage(instance);

    try {
      const detected = await detectCaptchas(page, typeFilter);
      const hasCaptcha = detected.length > 0;
      const pageUrl = page.url();

      if (!hasCaptcha) {
        ctxLog.info({ tool: 'browser.captcha', url: pageUrl }, 'No CAPTCHA detected');
        return {
          success: true,
          output: `No CAPTCHA detected on ${pageUrl}.`,
          data: { hasCaptcha: false, detected: [], url: pageUrl, requiresHuman: false, parked: false },
        };
      }

      const names = detected.map((d) => d.name).join(', ');
      ctxLog.warn({ tool: 'browser.captcha', url: pageUrl, detected: detected.map((d) => d.name) }, 'CAPTCHA detected — parking for human hand-off');

      // Operator hand-off. Best-effort: never let a notifier error break the tool.
      try {
        notify(
          'warning',
          'CAPTCHA / bot-wall hit',
          `A ${names} challenge is blocking ${pageUrl}. The agent has parked this task — ` +
            `complete the challenge in the browser session (or provide an alternative route) so it can continue.`,
          'high',
        );
      } catch (nerr) {
        ctxLog.error({ tool: 'browser.captcha', err: nerr }, 'Hand-off notification failed');
      }

      return {
        success: true,
        output:
          `CAPTCHA detected on ${pageUrl}: ${names}. Task PARKED for human hand-off — this agent does ` +
          `not solve CAPTCHAs. ${unattendedEnabled() ? 'Operator has been notified.' : 'A human should complete the challenge.'}`,
        data: { hasCaptcha: true, detected, url: pageUrl, requiresHuman: true, parked: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.captcha', err }, 'CAPTCHA detection failed');
      return { success: false, output: `browser.captcha error: ${msg}` };
    }
  },
};
