/**
 * @file type.ts
 * @description browser.type — type text into a page element.
 *
 * Uses page.fill() to atomically set the value of an input or textarea,
 * then optionally presses Enter to submit (useful for search boxes, chat
 * inputs, etc.). fill() clears any existing value before typing.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const typeTool: ToolDefinition = {
  name: 'browser.type',
  description:
    'Type text into an input field or textarea on the current browser page. ' +
    'Clears any existing value first. Optionally presses Enter after typing to submit.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    selector: {
      type: 'string',
      required: true,
      description:
        'CSS or Playwright selector of the input element. ' +
        'Examples: "#search-input", "[name=email]", "textarea.message".',
    },
    text: {
      type: 'string',
      required: true,
      description: 'The text to type into the element.',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance to use (default: "default").',
    },
    submit: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true, press Enter after typing to submit the form or query.',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 5000,
      description: 'Milliseconds to wait for the element (default: 5000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const selector = params['selector'];
    if (typeof selector !== 'string' || selector.trim() === '') {
      return { success: false, output: 'browser.type: "selector" is required.' };
    }

    const text = params['text'];
    if (typeof text !== 'string') {
      return { success: false, output: 'browser.type: "text" is required.' };
    }

    const browserName =
      typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const submit = params['submit'] === true;
    const timeout =
      typeof params['timeout'] === 'number' ? params['timeout'] : 5_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output:
          `browser.type: no browser instance named "${browserName}" found. ` +
          'Use browser.launch first.',
      };
    }

    const pages = instance.context.pages();
    const page =
      pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      // fill() sets the value atomically and dispatches input/change events
      await page.fill(selector, text, { timeout });

      if (submit) {
        await page.press(selector, 'Enter');
      }

      ctxLog.info(
        { tool: 'browser.type', selector, textLength: text.length, submit, browserName },
        'Text typed',
      );

      return {
        success: true,
        output:
          `Typed ${text.length} characters into "${selector}"` +
          (submit ? ' and pressed Enter.' : '.'),
        data: { selector, textLength: text.length, submit, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.type', selector, err }, 'Type failed');
      return { success: false, output: `browser.type error: ${msg}` };
    }
  },
};
