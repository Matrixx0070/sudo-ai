/**
 * @file screenshot.ts
 * @description browser.screenshot — capture the current page or a specific
 * element, save to disk, and return base64 image + path + dimensions.
 *
 * Returns base64 PNG so the AI can visually see the page (same pattern as
 * OpenAI's computer-use tool: screenshot() returns Base64-encoded PNG).
 */

import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

const DEFAULT_SCREENSHOT_DIR = 'data/screenshots';

export const screenshotTool: ToolDefinition = {
  name: 'browser.screenshot',
  description:
    'Take a screenshot of the current browser page or a specific element. ' +
    'Returns base64 PNG image data so you can visually see the page, plus saves to disk. ' +
    'Use this to observe the current state of the browser before deciding next action.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    path: {
      type: 'string',
      required: false,
      description: 'Output file path. Defaults to data/screenshots/{timestamp}.png.',
    },
    selector: {
      type: 'string',
      required: false,
      description: 'CSS selector of the element to screenshot. Omit for full viewport.',
    },
    fullPage: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Capture the full scrollable page (default: false, only viewport).',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const selector = typeof params['selector'] === 'string' ? params['selector'] : null;
    const fullPage = params['fullPage'] === true;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rawPath =
      typeof params['path'] === 'string' && params['path'].trim() !== ''
        ? params['path']
        : `${DEFAULT_SCREENSHOT_DIR}/${timestamp}.png`;
    const savePath = resolve(ctx.workingDir, rawPath);

    // Ensure output directory exists
    mkdirSync(dirname(savePath), { recursive: true });

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      let width = 0;
      let height = 0;
      let screenshotBuf: Buffer;

      if (selector) {
        const locator = page.locator(selector).first();
        screenshotBuf = await locator.screenshot({ path: savePath });
        const box = await locator.boundingBox();
        width = Math.round(box?.width ?? 0);
        height = Math.round(box?.height ?? 0);
      } else {
        screenshotBuf = await page.screenshot({ path: savePath, fullPage });
        const viewportSize = page.viewportSize();
        width = viewportSize?.width ?? 1280;
        height = fullPage
          ? await page.evaluate(() => document.documentElement.scrollHeight)
          : (viewportSize?.height ?? 800);
      }

      // Return base64 so the AI can visually see the page
      const base64 = screenshotBuf.toString('base64');
      const url = page.url();
      const title = await page.title().catch(() => '');

      ctxLog.info({ tool: 'browser.screenshot', savePath, width, height, url }, 'Screenshot captured');

      return {
        success: true,
        output: `Screenshot captured: ${url}\nTitle: ${title}\nSize: ${width}x${height}px\nSaved: ${savePath}\nbase64_image: data:image/png;base64,${base64}`,
        data: { path: savePath, width, height, selector, fullPage, url, title, base64 },
        artifacts: [{ path: savePath, action: 'created' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.screenshot', selector, err }, 'Screenshot failed');
      return { success: false, output: `browser.screenshot error: ${msg}` };
    }
  },
};
