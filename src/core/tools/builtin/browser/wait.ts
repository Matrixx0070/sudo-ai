/**
 * @file wait.ts
 * @description browser.wait — wait for a condition on the current page.
 *
 * Supports three wait strategies (applied in priority order):
 *   1. text  — wait until text string appears in the page body
 *   2. selector — wait until a CSS/Playwright selector is present in the DOM
 *   3. time  — wait an unconditional number of seconds
 *
 * At least one of text, selector, or time must be supplied.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

/** Maximum unconditional wait — 60 seconds. */
const MAX_WAIT_SECONDS = 60;

export const waitTool: ToolDefinition = {
  name: 'browser.wait',
  description:
    'Wait for a condition on the current browser page before continuing. ' +
    'Supply "text" to wait until that string appears in the page, ' +
    '"selector" to wait for an element to be present, or ' +
    '"time" (seconds) to wait unconditionally. ' +
    'Priority order when multiple are given: text > selector > time.',
  category: 'browser',
  timeout: 120_000,
  parameters: {
    text: {
      type: 'string',
      required: false,
      description:
        'Wait until this text string appears anywhere in the page body. ' +
        'Case-sensitive substring match.',
    },
    selector: {
      type: 'string',
      required: false,
      description:
        'Wait until this CSS or Playwright selector matches at least one element in the DOM.',
    },
    time: {
      type: 'number',
      required: false,
      description:
        `Unconditional wait duration in seconds (max ${MAX_WAIT_SECONDS}). ` +
        'Use when the page change is timing-based rather than DOM-based.',
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
      default: 30000,
      description:
        'Maximum milliseconds to wait for text or selector conditions (default: 30000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const text =
      typeof params['text'] === 'string' && params['text'].trim() !== ''
        ? params['text'].trim()
        : null;
    const selector =
      typeof params['selector'] === 'string' && params['selector'].trim() !== ''
        ? params['selector'].trim()
        : null;
    const rawTime = params['time'];
    const time =
      typeof rawTime === 'number' && rawTime > 0
        ? Math.min(rawTime, MAX_WAIT_SECONDS)
        : null;

    if (!text && !selector && time === null) {
      return {
        success: false,
        output:
          'browser.wait: at least one of "text", "selector", or "time" must be provided.',
      };
    }

    const browserName =
      typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const timeout =
      typeof params['timeout'] === 'number' ? params['timeout'] : 30_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output:
          `browser.wait: no browser instance named "${browserName}" found. ` +
          'Use browser.launch first.',
      };
    }

    const pages = instance.context.pages();
    const page =
      pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      if (text !== null) {
        // Wait until the text appears anywhere in the document body
        await page.waitForFunction(
          (needle: string) => document.body.textContent?.includes(needle) ?? false,
          text,
          { timeout },
        );
        ctxLog.info({ tool: 'browser.wait', text, browserName }, 'Text appeared');
        return {
          success: true,
          output: `Text "${text}" appeared on the page.`,
          data: { waited: 'text', text, url: page.url() },
        };
      }

      if (selector !== null) {
        await page.waitForSelector(selector, { state: 'attached', timeout });
        ctxLog.info({ tool: 'browser.wait', selector, browserName }, 'Selector appeared');
        return {
          success: true,
          output: `Selector "${selector}" is now present in the DOM.`,
          data: { waited: 'selector', selector, url: page.url() },
        };
      }

      // Unconditional time-based wait (time is non-null here)
      const ms = (time as number) * 1_000;
      await page.waitForTimeout(ms);
      ctxLog.info({ tool: 'browser.wait', seconds: time, browserName }, 'Timed wait complete');
      return {
        success: true,
        output: `Waited ${time} second(s).`,
        data: { waited: 'time', seconds: time, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.wait', text, selector, time, err }, 'Wait failed');
      return { success: false, output: `browser.wait error: ${msg}` };
    }
  },
};
