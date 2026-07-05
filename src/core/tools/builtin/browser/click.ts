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
import { resolveActivePage } from './active-page.js';
import { resolveStableRef, parseRefParam, refNotFoundOutput } from './stable-ref.js';
import { withRetry } from './resilience.js';

export const clickTool: ToolDefinition = {
  name: 'browser.click',
  description:
    'Click an element on the current browser page. Target it EITHER by a stable "ref" ' +
    'from browser.snapshot (preferred — exact, duplicate-name-proof) OR by a CSS/text ' +
    'selector. Selector supports Playwright syntax: "text=Submit", "#btn-ok", ".menu-item".',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    ref: {
      type: 'number',
      required: false,
      description:
        'Stable element ref from a prior browser.snapshot (e.g. 12). Preferred over ' +
        'selector: targets the exact element even when several share the same name.',
    },
    selector: {
      type: 'string',
      required: false,
      description:
        'CSS selector or Playwright text selector of the element to click. ' +
        'Examples: "#submit-btn", "text=Sign In", "[data-testid=close]". ' +
        'Ignored when "ref" is provided.',
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

    const ref = parseRefParam(params['ref']);
    const selector = params['selector'];
    const hasSelector = typeof selector === 'string' && selector.trim() !== '';
    if (ref === null && !hasSelector) {
      return { success: false, output: 'browser.click: provide "ref" (from browser.snapshot) or "selector".' };
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

    const page = await resolveActivePage(instance);

    const target = ref !== null ? `ref=${ref}` : (selector as string);

    try {
      if (ref !== null) {
        const locator = await resolveStableRef(page, ref);
        if (!locator) {
          return { success: false, output: await refNotFoundOutput(page, ref, 'browser.click') };
        }
        await withRetry(() => locator.click({ timeout, button, clickCount }));
      } else {
        await withRetry(() => page.click(selector as string, { timeout, button, clickCount }));
      }

      ctxLog.info(
        { tool: 'browser.click', target, button, clickCount, browserName },
        'Click performed',
      );

      return {
        success: true,
        output: `Clicked ${target} (button=${button}, clicks=${clickCount}).`,
        data: { ref: ref ?? undefined, selector: ref === null ? selector : undefined, button, clickCount, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.click', target, err }, 'Click failed');
      const isTimeout = msg.includes('Timeout') || msg.includes('timeout') || msg.includes('not found');
      const hint = isTimeout
        ? `\n\nRECOVERY REQUIRED: ${target} not actionable.\n` +
          `MANDATORY NEXT STEP: Call browser.snapshot to refresh stable refs, ` +
          `then retry browser.click with the correct ref=N.\n` +
          `NOTE: text= selectors are case-sensitive. Never give up after one failure.`
        : '';
      return { success: false, output: `browser.click error: ${msg}${hint}` };
    }
  },
};
