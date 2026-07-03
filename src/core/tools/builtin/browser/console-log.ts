/**
 * @file console-log.ts
 * @description browser.console — read console messages and page errors captured
 * on the current browser context. Equivalent to Playwright MCP's
 * browser_console_messages. Lets the agent autonomously spot JS errors that
 * explain a broken page without a screenshot.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { getConsole } from './page-events.js';

export const consoleTool: ToolDefinition = {
  name: 'browser.console',
  description:
    'List console messages and uncaught page errors captured for the current browser ' +
    'context. Filter to errors only to quickly find the JS failure behind a broken page.',
  category: 'browser',
  timeout: 15_000,
  parameters: {
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    onlyErrors: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Only console.error and uncaught page errors.',
    },
    limit: {
      type: 'number',
      required: false,
      default: 50,
      description: 'Max entries to return, most recent last (default: 50).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    await resolveActivePage(instance);

    const entries = getConsole(instance.context, {
      onlyErrors: params['onlyErrors'] === true,
      limit: typeof params['limit'] === 'number' ? params['limit'] : 50,
    });

    ctxLog.info({ tool: 'browser.console', count: entries.length }, 'Console entries read');

    if (entries.length === 0) {
      return {
        success: true,
        output: 'No matching console messages captured yet (capture starts on first browser interaction).',
        data: { entries: [] },
      };
    }

    const lines = entries.map((e) => `[${e.type}] ${e.text}`);
    return {
      success: true,
      output: `Console messages (${entries.length}):\n${lines.join('\n')}`,
      data: { entries },
    };
  },
};
