/**
 * @file navigate.ts
 * @description browser.navigate — navigate a browser instance to a URL and
 * return the final URL, title, and HTTP status code.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { withRetry } from './resilience.js';

export const navigateTool: ToolDefinition = {
  name: 'browser.navigate',
  description:
    'Navigate a browser instance to a URL. Returns the final URL (after redirects), ' +
    'page title, and HTTP status code.',
  category: 'browser',
  timeout: 60_000,
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: 'The URL to navigate to.',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance to use (default: "default").',
    },
    waitUntil: {
      type: 'string',
      required: false,
      default: 'domcontentloaded',
      enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
      description: 'When to consider navigation complete.',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 30000,
      description: 'Navigation timeout in milliseconds (default: 30000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const url = params['url'];
    if (typeof url !== 'string' || url.trim() === '') {
      return { success: false, output: 'browser.navigate: "url" parameter is required.' };
    }

    // Validate URL format
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, output: `browser.navigate: invalid URL "${url}".` };
    }

    // Phase 6: SSRF protection — block navigation to private IPs
    const ssrfGuard = BrowserManager.getInstance().getSSRFGuard();
    const ssrfResult = await ssrfGuard.checkUrl(url);
    if (!ssrfResult.allowed) {
      ctxLog.info({ tool: 'browser.navigate', url, reason: ssrfResult.reason, category: ssrfResult.category }, 'SSRF check blocked navigation');
      return {
        success: false,
        output: `browser.navigate: blocked by SSRF guard — ${ssrfResult.reason}`,
        data: { ssrf: ssrfResult },
      };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const waitUntil = (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(
      String(params['waitUntil']),
    )
      ? params['waitUntil']
      : 'domcontentloaded') as 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const page = await resolveActivePage(instance);

    try {
      // Use goto()'s returned response for the status — the previous approach
      // registered a 'response' listener AFTER page setup, which raced the goto
      // promise (status was usually 0) and leaked a listener per navigation.
      // Retry transient navigation failures (DNS blips, mid-load teardown).
      const mainResponse = await withRetry(() => page.goto(url, { waitUntil, timeout }));
      const httpStatus = mainResponse?.status() ?? 0;
      void parsedUrl;

      // Handle Chrome security interstitials: "Your connection is not private" / "This web app may not be secured"
      // These are real HTML pages with a proceed button, not JS dialogs
      const currentUrl = page.url();
      if (currentUrl.startsWith('chrome-error://') || currentUrl.includes('interstitial')) {
        // Try clicking "Advanced" then "Proceed" to bypass the warning
        await page.locator('#details-button, #proceed-link, [id*="proceed"]').first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }

      // Also handle the "This site is not secure" warning page
      const pageContent = await page.content().catch(() => '');
      if (pageContent.includes('NET::ERR_CERT') || pageContent.includes('not secure') || pageContent.includes('not private')) {
        await page.locator('#details-button').click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('#proceed-link, a[id*="proceed"]').click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }

      const finalUrl = page.url();
      const title = await page.title();

      ctxLog.info({ tool: 'browser.navigate', url, finalUrl, title, httpStatus }, 'Navigation complete');

      return {
        success: true,
        output: `Navigated to: ${finalUrl}\nTitle: ${title}\nStatus: ${httpStatus || '(not captured)'}`,
        data: { url: finalUrl, title, status: httpStatus },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.navigate', url, err }, 'Navigation failed');
      return { success: false, output: `browser.navigate error: ${msg}` };
    }
  },
};
