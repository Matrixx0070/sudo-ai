/**
 * @file history.ts
 * @description browser.history — navigate the active tab's session history
 * (back / forward / reload). Salvaged from the never-registered BrowserActionSuite,
 * which was the only place these existed; no history-navigation tool was reachable
 * by the agent before.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { withRetry } from './resilience.js';

const VALID_OPS = ['back', 'forward', 'reload'] as const;
type HistoryOp = (typeof VALID_OPS)[number];

export const historyTool: ToolDefinition = {
  name: 'browser.history',
  description:
    'Navigate the current browser tab through its session history: ' +
    'back (previous page), forward (next page), or reload (refresh the current page).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: [...VALID_OPS],
      description: 'History operation: back, forward, or reload.',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    waitUntil: {
      type: 'string',
      required: false,
      default: 'domcontentloaded',
      enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
      description: 'When to consider the navigation complete (default: domcontentloaded).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const op = params['operation'];
    if (typeof op !== 'string' || !(VALID_OPS as readonly string[]).includes(op)) {
      return { success: false, output: `browser.history: "operation" must be one of: ${VALID_OPS.join('|')}.` };
    }
    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const waitUntil = (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(String(params['waitUntil']))
      ? params['waitUntil']
      : 'domcontentloaded') as 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    const page = await resolveActivePage(instance);

    try {
      // Compare the URL before/after to detect "no history entry" — goBack/goForward
      // return a null response for data: URLs and same-document navigations even when
      // they DO navigate, so the response object alone is not a reliable signal.
      if ((op as HistoryOp) === 'back') {
        const before = page.url();
        await withRetry(() => page.goBack({ waitUntil, timeout: 20_000 }));
        if (page.url() === before) return { success: false, output: 'browser.history: nothing to go back to (no prior history entry).' };
      } else if ((op as HistoryOp) === 'forward') {
        const before = page.url();
        await withRetry(() => page.goForward({ waitUntil, timeout: 20_000 }));
        if (page.url() === before) return { success: false, output: 'browser.history: nothing to go forward to (no next history entry).' };
      } else {
        await withRetry(() => page.reload({ waitUntil, timeout: 20_000 }));
      }

      const url = page.url();
      const title = await page.title().catch(() => '');
      ctxLog.info({ tool: 'browser.history', op, url, browserName }, 'History navigation complete');
      return {
        success: true,
        output: `${op} → ${title ? `"${title}" ` : ''}(${url})`,
        data: { operation: op, url, title },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.history', op, err }, 'History navigation failed');
      return { success: false, output: `browser.history error: ${msg}` };
    }
  },
};
