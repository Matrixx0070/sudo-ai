/**
 * @file network.ts
 * @description browser.network — inspect network responses captured on the
 * current browser context. Equivalent to Playwright MCP's browser_network_requests,
 * useful for autonomous debugging (spot 4xx/5xx, failed API calls, redirects)
 * without a screenshot.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { getNetwork } from './page-events.js';

export const networkTool: ToolDefinition = {
  name: 'browser.network',
  description:
    'List network responses captured for the current browser context (method, URL, ' +
    'status, resource type). Filter to failures/4xx/5xx or by URL substring to diagnose ' +
    'why a page or API call is not working — no screenshot needed.',
  category: 'browser',
  timeout: 15_000,
  parameters: {
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    urlIncludes: {
      type: 'string',
      required: false,
      description: 'Only entries whose URL contains this substring.',
    },
    onlyFailed: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'Only failed requests and responses with status >= 400.',
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
    // Resolve the active page to guarantee capture is attached to this context.
    await resolveActivePage(instance);

    const entries = getNetwork(instance.context, {
      urlIncludes: typeof params['urlIncludes'] === 'string' ? params['urlIncludes'] : undefined,
      onlyFailed: params['onlyFailed'] === true,
      limit: typeof params['limit'] === 'number' ? params['limit'] : 50,
    });

    ctxLog.info({ tool: 'browser.network', count: entries.length }, 'Network entries read');

    if (entries.length === 0) {
      return {
        success: true,
        output: 'No matching network entries captured yet (capture starts on first browser interaction).',
        data: { entries: [] },
      };
    }

    const lines = entries.map(
      (e) => `${e.failed ? 'FAIL' : e.status} ${e.method} ${e.resourceType} ${e.url}` +
        (e.failureText ? ` (${e.failureText})` : ''),
    );
    return {
      success: true,
      output: `Network entries (${entries.length}):\n${lines.join('\n')}`,
      data: { entries },
    };
  },
};
