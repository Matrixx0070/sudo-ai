/**
 * @file snapshot.ts
 * @description browser.snapshot — capture an ARIA accessibility snapshot of
 * the current page, equivalent to Playwright MCP's browser_snapshot.
 *
 * Uses the modern Playwright ariaSnapshot() API (available since v1.35) on
 * the page body locator. Returns YAML-formatted ARIA tree text that describes
 * every interactive and informational element, enabling an LLM to understand
 * page layout and identify selectors without needing a screenshot.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const snapshotTool: ToolDefinition = {
  name: 'browser.snapshot',
  description:
    'Capture an ARIA accessibility snapshot of the current browser page. ' +
    'Returns a YAML-formatted tree of all visible roles, names, and values — ' +
    'use this to identify selectors and understand page structure without a screenshot.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance to snapshot (default: "default").',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 10000,
      description: 'Milliseconds to wait for the page to be ready (default: 10000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const browserName =
      typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const timeout =
      typeof params['timeout'] === 'number' ? params['timeout'] : 10_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output:
          `browser.snapshot: no browser instance named "${browserName}" found. ` +
          'Use browser.launch with operation="launch" or operation="connect" first.',
      };
    }

    const pages = instance.context.pages();
    const page =
      pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      // ariaSnapshot() returns a YAML string describing the ARIA tree.
      // It is available on locators; we target the document body.
      const snapshot: string = await page
        .locator('body')
        .ariaSnapshot({ timeout });

      const url = page.url();
      const title = await page.title().catch(() => '');
      const lineCount = snapshot.split('\n').length;

      ctxLog.info(
        { tool: 'browser.snapshot', browserName, url, lineCount },
        'Snapshot captured',
      );

      return {
        success: true,
        output: `ARIA snapshot of "${title}" (${url}):\n\n${snapshot}`,
        data: { url, title, snapshot, lineCount },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.snapshot', browserName, err }, 'Snapshot failed');
      return { success: false, output: `browser.snapshot error: ${msg}` };
    }
  },
};
