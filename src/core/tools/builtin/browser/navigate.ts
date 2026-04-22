/**
 * @file navigate.ts
 * @description browser.navigate — navigate a browser instance to a URL and
 * return the final URL, title, and HTTP status code.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

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

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const waitUntil = (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(
      String(params['waitUntil']),
    )
      ? params['waitUntil']
      : 'domcontentloaded') as 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      let httpStatus = 0;
      page.on('response', (response) => {
        if (response.url() === parsedUrl.href || response.url().startsWith(parsedUrl.origin)) {
          httpStatus = response.status();
        }
      });

      await page.goto(url, { waitUntil, timeout });

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
