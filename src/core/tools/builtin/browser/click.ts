/**
 * @file click.ts
 * @description browser.click — click an element on the current page identified
 * by a CSS selector or Playwright text selector.
 *
 * Unlike browser.interact (which uses locator-based API), this tool uses
 * page.click() directly, enabling button text selectors such as
 * "text=Submit" or ":text('Login')" alongside regular CSS selectors.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const clickTool: ToolDefinition = {
  name: 'browser.click',
  description:
    'Click an element on the current browser page identified by a CSS or text selector. ' +
    'Supports Playwright selector syntax: "text=Submit", "#btn-ok", ".menu-item", etc.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    selector: {
      type: 'string',
      required: true,
      description:
        'CSS selector or Playwright text selector of the element to click. ' +
        'Examples: "#submit-btn", "text=Sign In", "[data-testid=close]".',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance to use (default: "default").',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 5000,
      description: 'Milliseconds to wait for the element before failing (default: 5000).',
    },
    button: {
      type: 'string',
      required: false,
      default: 'left',
      enum: ['left', 'right', 'middle'],
      description: 'Mouse button to use (default: "left").',
    },
    clickCount: {
      type: 'number',
      required: false,
      default: 1,
      description: 'Number of clicks (default: 1; use 2 for double-click).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const selector = params['selector'];
    if (typeof selector !== 'string' || selector.trim() === '') {
      return { success: false, output: 'browser.click: "selector" is required.' };
    }

    const browserName =
      typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const timeout =
      typeof params['timeout'] === 'number' ? params['timeout'] : 5_000;
    const validButtons = ['left', 'right', 'middle'] as const;
    type MouseButton = (typeof validButtons)[number];
    const rawButton = params['button'];
    const button: MouseButton =
      typeof rawButton === 'string' && (validButtons as readonly string[]).includes(rawButton)
        ? (rawButton as MouseButton)
        : 'left';
    const clickCount =
      typeof params['clickCount'] === 'number' && params['clickCount'] > 0
        ? params['clickCount']
        : 1;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output:
          `browser.click: no browser instance named "${browserName}" found. ` +
          'Use browser.launch first.',
      };
    }

    const pages = instance.context.pages();
    const page =
      pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      await page.click(selector, { timeout, button, clickCount });

      ctxLog.info(
        { tool: 'browser.click', selector, button, clickCount, browserName },
        'Click performed',
      );

      return {
        success: true,
        output: `Clicked "${selector}" (button=${button}, clicks=${clickCount}).`,
        data: { selector, button, clickCount, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.click', selector, err }, 'Click failed');
      const isTimeout = msg.includes('Timeout') || msg.includes('timeout') || msg.includes('not found');
      const hint = isTimeout
        ? `\n\nRECOVERY REQUIRED: Selector "${selector}" not found.\n` +
          `MANDATORY NEXT STEP: Call browser.snapshot to get the real ARIA tree, ` +
          `find the correct role=button[name="..."] selector, then retry.\n` +
          `NOTE: text= selectors are case-sensitive. Never give up after one failure.`
        : '';
      return { success: false, output: `browser.click error: ${msg}${hint}` };
    }
  },
};
