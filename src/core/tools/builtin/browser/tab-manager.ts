/**
 * @file tab-manager.ts
 * @description browser.tabs — manage browser tabs/pages within a named
 * browser instance. Operations: open, close, switch, list.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const tabManagerTool: ToolDefinition = {
  name: 'browser.tabs',
  description:
    'Manage browser tabs. Operations: open (new tab, optionally navigate), ' +
    'close (close tab by index), switch (bring tab to front by index), ' +
    'list (return all open tabs with index, URL, and title).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['open', 'close', 'switch', 'list'],
      description: 'Tab operation to perform.',
    },
    url: {
      type: 'string',
      required: false,
      description: 'URL to navigate to when opening a new tab.',
    },
    tabIndex: {
      type: 'number',
      required: false,
      description: 'Zero-based tab index for close/switch operations.',
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

    const op = params['operation'];
    if (typeof op !== 'string' || !['open', 'close', 'switch', 'list'].includes(op)) {
      return { success: false, output: 'browser.tabs: "operation" must be open|close|switch|list.' };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const url = typeof params['url'] === 'string' ? params['url'] : null;
    const tabIndex = typeof params['tabIndex'] === 'number' ? params['tabIndex'] : null;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    try {
      if (op === 'list') {
        const pages = instance.context.pages();
        const tabs = await Promise.all(
          pages.map(async (p, i) => ({
            index: i,
            url: p.url(),
            title: await p.title().catch(() => ''),
          })),
        );
        ctxLog.info({ tool: 'browser.tabs', op, count: tabs.length }, 'Listed tabs');
        return {
          success: true,
          output: `Open tabs (${tabs.length}):\n` +
            tabs.map((t) => `  [${t.index}] ${t.title || '(no title)'} — ${t.url}`).join('\n'),
          data: { tabs },
        };
      }

      if (op === 'open') {
        const newPage = await instance.context.newPage();
        const newIndex = instance.context.pages().length - 1;
        if (url) {
          await newPage.goto(url, { waitUntil: 'domcontentloaded' });
        }
        const title = await newPage.title().catch(() => '');
        ctxLog.info({ tool: 'browser.tabs', op, url, index: newIndex }, 'Tab opened');
        return {
          success: true,
          output: `Opened new tab [${newIndex}]${url ? ` → ${url}` : ''}.`,
          data: { index: newIndex, url: newPage.url(), title },
        };
      }

      // close or switch require tabIndex
      if (tabIndex === null || tabIndex < 0) {
        return { success: false, output: 'browser.tabs: "tabIndex" required for close/switch.' };
      }

      const pages = instance.context.pages();
      if (tabIndex >= pages.length) {
        return {
          success: false,
          output: `browser.tabs: tab index ${tabIndex} out of range (0–${pages.length - 1}).`,
        };
      }

      const targetPage = pages[tabIndex]!;

      if (op === 'close') {
        await targetPage.close();
        ctxLog.info({ tool: 'browser.tabs', op, tabIndex }, 'Tab closed');
        return { success: true, output: `Closed tab [${tabIndex}].`, data: { tabIndex } };
      }

      // op === 'switch'
      await targetPage.bringToFront();
      const title = await targetPage.title().catch(() => '');
      ctxLog.info({ tool: 'browser.tabs', op, tabIndex, url: targetPage.url() }, 'Tab switched');
      return {
        success: true,
        output: `Switched to tab [${tabIndex}]: ${title || targetPage.url()}`,
        data: { tabIndex, url: targetPage.url(), title },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.tabs', op, err }, 'Tab operation failed');
      return { success: false, output: `browser.tabs error: ${msg}` };
    }
  },
};
