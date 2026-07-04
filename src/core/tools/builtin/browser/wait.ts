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

import type { Page } from 'playwright-core';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';

/** Maximum unconditional wait — 60 seconds. */
const MAX_WAIT_SECONDS = 60;

/**
 * True if `needle` appears anywhere on the page — light DOM, open shadow roots,
 * OR any (same-or-cross-origin) frame. The old check only read
 * document.body.textContent of the main frame, so text inside iframes (logins,
 * payments) and shadow-DOM widgets was invisible.
 */
export async function pageContainsTextDeep(page: Page, needle: string): Promise<boolean> {
  // Runs in each frame's context: walks light DOM + open shadow roots.
  const deepFind = (search: string): boolean => {
    const visit = (node: Node): boolean => {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        return (node.textContent ?? '').includes(search);
      }
      const el = node as Element & { shadowRoot?: ShadowRoot | null };
      if (el.shadowRoot) {
        for (const c of Array.from(el.shadowRoot.childNodes)) if (visit(c)) return true;
      }
      for (const c of Array.from(node.childNodes)) if (visit(c)) return true;
      return false;
    };
    return visit(document.documentElement);
  };

  for (const frame of page.frames()) {
    const found = await frame.evaluate(deepFind, needle).catch(() => false);
    if (found) return true;
  }
  return false;
}

export const waitTool: ToolDefinition = {
  name: 'browser.wait',
  description:
    'Wait for a condition on the current browser page before continuing. Supply one of: ' +
    '"url" (wait for the URL to match a glob), "loadState" (load/domcontentloaded/networkidle), ' +
    '"function" (a JS expression to become truthy), "text" (string appears on the page), ' +
    '"selector" (element present), or "time" (seconds, unconditional). ' +
    'Priority when multiple are given: url > loadState > function > text > selector > time.',
  category: 'browser',
  timeout: 120_000,
  parameters: {
    url: {
      type: 'string',
      required: false,
      description: 'Wait until the page URL matches this string or glob (e.g. "**/dashboard").',
    },
    loadState: {
      type: 'string',
      required: false,
      enum: ['load', 'domcontentloaded', 'networkidle'],
      description: 'Wait until the page reaches this load state.',
    },
    function: {
      type: 'string',
      required: false,
      description:
        'Wait until this JS expression evaluates truthy in the page context ' +
        '(e.g. "document.querySelectorAll(\'.row\').length > 5").',
    },
    text: {
      type: 'string',
      required: false,
      description:
        'Wait until this text string appears anywhere on the page, including inside ' +
        'iframes and shadow DOM. Case-sensitive substring match.',
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

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    const url = str(params['url']);
    const loadState = (['load', 'domcontentloaded', 'networkidle'].includes(String(params['loadState']))
      ? params['loadState']
      : null) as 'load' | 'domcontentloaded' | 'networkidle' | null;
    const waitFn = str(params['function']);
    const text = str(params['text']);
    const selector = str(params['selector']);
    const rawTime = params['time'];
    const time =
      typeof rawTime === 'number' && rawTime > 0
        ? Math.min(rawTime, MAX_WAIT_SECONDS)
        : null;

    if (!url && !loadState && !waitFn && !text && !selector && time === null) {
      return {
        success: false,
        output:
          'browser.wait: at least one of "url", "loadState", "function", "text", "selector", or "time" must be provided.',
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

    const page = await resolveActivePage(instance);

    try {
      if (url !== null) {
        await page.waitForURL(url, { timeout });
        ctxLog.info({ tool: 'browser.wait', url, browserName }, 'URL matched');
        return { success: true, output: `URL now matches "${url}": ${page.url()}`, data: { waited: 'url', url: page.url() } };
      }

      if (loadState !== null) {
        await page.waitForLoadState(loadState, { timeout });
        ctxLog.info({ tool: 'browser.wait', loadState, browserName }, 'Load state reached');
        return { success: true, output: `Page reached load state "${loadState}".`, data: { waited: 'loadState', loadState, url: page.url() } };
      }

      if (waitFn !== null) {
        await page.waitForFunction(waitFn, { timeout });
        ctxLog.info({ tool: 'browser.wait', browserName }, 'Function condition met');
        return { success: true, output: `Condition met: ${waitFn}`, data: { waited: 'function', url: page.url() } };
      }

      if (text !== null) {
        // Poll for the text across all frames + shadow DOM until timeout.
        const deadline = Date.now() + timeout;
        let appeared = false;
        while (Date.now() < deadline) {
          if (await pageContainsTextDeep(page, text)) { appeared = true; break; }
          await page.waitForTimeout(250);
        }
        if (!appeared) throw new Error(`Text "${text}" did not appear within ${timeout}ms`);
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
      ctxLog.error({ tool: 'browser.wait', url, loadState, waitFn, text, selector, time, err }, 'Wait failed');
      return { success: false, output: `browser.wait error: ${msg}` };
    }
  },
};
