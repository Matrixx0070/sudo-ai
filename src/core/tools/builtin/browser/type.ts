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
import { resolveActivePage } from './active-page.js';
import { resolveStableRef, parseRefParam } from './stable-ref.js';

export const typeTool: ToolDefinition = {
  name: 'browser.type',
  description:
    'Type text into an input field or textarea. Target it EITHER by a stable "ref" from ' +
    'browser.snapshot (preferred — exact) OR by a CSS/Playwright selector. ' +
    'Clears any existing value first. Optionally presses Enter after typing to submit.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    ref: {
      type: 'number',
      required: false,
      description:
        'Stable element ref from a prior browser.snapshot (e.g. 7). Preferred over selector.',
    },
    selector: {
      type: 'string',
      required: false,
      description:
        'CSS or Playwright selector of the input element. ' +
        'Examples: "#search-input", "[name=email]", "textarea.message". ' +
        'Ignored when "ref" is provided.',
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

    const ref = parseRefParam(params['ref']);
    const selector = params['selector'];
    const hasSelector = typeof selector === 'string' && selector.trim() !== '';
    if (ref === null && !hasSelector) {
      return { success: false, output: 'browser.type: provide "ref" (from browser.snapshot) or "selector".' };
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

    const page = await resolveActivePage(instance);

    const target = ref !== null ? `ref=${ref}` : (selector as string);

    try {
      // fill() sets the value atomically and dispatches input/change events
      if (ref !== null) {
        const locator = await resolveStableRef(page, ref);
        if (!locator) {
          return {
            success: false,
            output:
              `browser.type: ref=${ref} not found on the page. The page may have re-rendered ` +
              `since the last snapshot — call browser.snapshot again to get fresh refs.`,
          };
        }
        await locator.fill(text, { timeout });
        if (submit) await locator.press('Enter');
      } else {
        await page.fill(selector as string, text, { timeout });
        if (submit) await page.press(selector as string, 'Enter');
      }

      ctxLog.info(
        { tool: 'browser.type', target, textLength: text.length, submit, browserName },
        'Text typed',
      );

      return {
        success: true,
        output:
          `Typed ${text.length} characters into ${target}` +
          (submit ? ' and pressed Enter.' : '.'),
        data: { ref: ref ?? undefined, selector: ref === null ? selector : undefined, textLength: text.length, submit, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.type', target, err }, 'Type failed');
      return { success: false, output: `browser.type error: ${msg}` };
    }
  },
};
