/**
 * @file interact.ts
 * @description browser.interact — perform UI actions on the current page:
 * click, type, scroll, select, press, hover.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

type InteractAction = 'click' | 'type' | 'scroll' | 'select' | 'press' | 'hover';
const VALID_ACTIONS: InteractAction[] = ['click', 'type', 'scroll', 'select', 'press', 'hover'];

export const interactTool: ToolDefinition = {
  name: 'browser.interact',
  description:
    'Interact with the current browser page. Actions: click (element), type (text into field), ' +
    'scroll (window or element), select (dropdown), press (keyboard key), hover (element).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: VALID_ACTIONS,
      description: 'Action to perform.',
    },
    selector: {
      type: 'string',
      required: false,
      description: 'CSS selector or text selector to target. Required for most actions.',
    },
    text: {
      type: 'string',
      required: false,
      description: 'Text to type (for "type" action) or option to select (for "select" action).',
    },
    key: {
      type: 'string',
      required: false,
      description: 'Key to press, e.g. "Enter", "Tab", "Escape" (for "press" action).',
    },
    scrollX: {
      type: 'number',
      required: false,
      default: 0,
      description: 'Horizontal scroll distance in pixels (for "scroll" action).',
    },
    scrollY: {
      type: 'number',
      required: false,
      default: 300,
      description: 'Vertical scroll distance in pixels (for "scroll" action).',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 10000,
      description: 'Timeout in milliseconds for the action (default: 10000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const action = params['action'];
    if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as InteractAction)) {
      return {
        success: false,
        output: `browser.interact: "action" must be one of: ${VALID_ACTIONS.join(', ')}.`,
      };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const selector = typeof params['selector'] === 'string' ? params['selector'] : null;
    const text = typeof params['text'] === 'string' ? params['text'] : null;
    const key = typeof params['key'] === 'string' ? params['key'] : null;
    const scrollX = typeof params['scrollX'] === 'number' ? params['scrollX'] : 0;
    const scrollY = typeof params['scrollY'] === 'number' ? params['scrollY'] : 300;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      switch (action as InteractAction) {
        case 'click': {
          if (!selector) return { success: false, output: 'browser.interact: "selector" required for click.' };
          await page.locator(selector).first().click({ timeout });
          break;
        }
        case 'type': {
          if (!selector) return { success: false, output: 'browser.interact: "selector" required for type.' };
          if (!text) return { success: false, output: 'browser.interact: "text" required for type.' };
          await page.locator(selector).first().fill(text, { timeout });
          break;
        }
        case 'scroll': {
          if (selector) {
            await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout });
          } else {
            await page.evaluate(({ x, y }: { x: number; y: number }) => window.scrollBy(x, y), { x: scrollX, y: scrollY });
          }
          break;
        }
        case 'select': {
          if (!selector) return { success: false, output: 'browser.interact: "selector" required for select.' };
          if (!text) return { success: false, output: 'browser.interact: "text" required for select.' };
          await page.locator(selector).first().selectOption({ label: text }, { timeout });
          break;
        }
        case 'press': {
          if (!key) return { success: false, output: 'browser.interact: "key" required for press.' };
          if (selector) {
            await page.locator(selector).first().press(key, { timeout });
          } else {
            await page.keyboard.press(key);
          }
          break;
        }
        case 'hover': {
          if (!selector) return { success: false, output: 'browser.interact: "selector" required for hover.' };
          await page.locator(selector).first().hover({ timeout });
          break;
        }
      }

      ctxLog.info({ tool: 'browser.interact', action, selector }, 'Action performed');
      return {
        success: true,
        output: `Action "${action}" completed${selector ? ` on "${selector}"` : ''}.`,
        data: { action, selector, text, key },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.interact', action, selector, err }, 'Action failed');
      const isTimeout = msg.includes('Timeout') || msg.includes('timeout');
      const hint = isTimeout
        ? `\n\nRECOVERY REQUIRED: The selector "${selector}" was not found or timed out.\n` +
          `MANDATORY NEXT STEP: Call browser.snapshot NOW to get the real ARIA accessibility tree, ` +
          `find the correct role/name selector, then retry browser.interact with the correct selector.\n` +
          `NOTE: text= selectors are case-sensitive. Use role=button[name="..."] format from snapshot instead.`
        : '';
      return { success: false, output: `browser.interact error: ${msg}${hint}` };
    }
  },
};
