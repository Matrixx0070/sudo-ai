/**
 * @file download.ts
 * @description browser.download — download a file either by navigating to a
 * direct URL or by clicking a download-triggering element on the page.
 * Returns the saved path and file size.
 */

import { createWriteStream, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';

const DEFAULT_DOWNLOAD_DIR = 'data/downloads';

export const downloadTool: ToolDefinition = {
  name: 'browser.download',
  description:
    'Download a file via the browser. Provide either a direct "url" for HTTP download, or a ' +
    '"selector" that triggers a download event when clicked. Saves to "savePath".',
  category: 'browser',
  timeout: 120_000,
  parameters: {
    url: {
      type: 'string',
      required: false,
      description: 'Direct URL to download (bypasses browser, uses fetch).',
    },
    selector: {
      type: 'string',
      required: false,
      description: 'CSS selector for a link/button that triggers a file download.',
    },
    savePath: {
      type: 'string',
      required: false,
      description: 'Destination file path. Defaults to data/downloads/{filename}.',
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

    const url = typeof params['url'] === 'string' ? params['url'] : null;
    const selector = typeof params['selector'] === 'string' ? params['selector'] : null;
    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';

    if (!url && !selector) {
      return { success: false, output: 'browser.download: provide either "url" or "selector".' };
    }

    try {
      // Direct URL download via node fetch (no playwright needed)
      if (url && !selector) {
        const parsedUrl = new URL(url);
        const filename = basename(parsedUrl.pathname) || `download-${Date.now()}`;
        const rawSavePath = typeof params['savePath'] === 'string' && params['savePath'].trim()
          ? params['savePath']
          : `${DEFAULT_DOWNLOAD_DIR}/${filename}`;
        const savePath = resolve(ctx.workingDir, rawSavePath);
        mkdirSync(dirname(savePath), { recursive: true });

        const response = await fetch(url, { signal: ctx.signal });
        if (!response.ok) {
          return { success: false, output: `browser.download: HTTP ${response.status} for ${url}` };
        }
        if (!response.body) {
          return { success: false, output: 'browser.download: empty response body.' };
        }

        const writer = createWriteStream(savePath);
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), writer);

        const { size } = statSync(savePath);
        ctxLog.info({ tool: 'browser.download', url, savePath, size }, 'Direct download complete');
        return {
          success: true,
          output: `Downloaded to ${savePath} (${size} bytes)`,
          data: { path: savePath, size, url },
          artifacts: [{ path: savePath, action: 'created', size }],
        };
      }

      // Playwright-driven download via element click
      const manager = BrowserManager.getInstance();
      const instance = await manager.getOrConnect(browserName);

      const page = await resolveActivePage(instance);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator(selector!).first().click(),
      ]);

      const suggestedFilename = download.suggestedFilename();
      const rawSavePath = typeof params['savePath'] === 'string' && params['savePath'].trim()
        ? params['savePath']
        : `${DEFAULT_DOWNLOAD_DIR}/${suggestedFilename}`;
      const savePath = resolve(ctx.workingDir, rawSavePath);
      mkdirSync(dirname(savePath), { recursive: true });

      await download.saveAs(savePath);
      const { size } = statSync(savePath);

      ctxLog.info({ tool: 'browser.download', selector, savePath, size }, 'Browser download complete');
      return {
        success: true,
        output: `Downloaded "${suggestedFilename}" to ${savePath} (${size} bytes)`,
        data: { path: savePath, size, filename: suggestedFilename },
        artifacts: [{ path: savePath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.download', url, selector, err }, 'Download failed');
      return { success: false, output: `browser.download error: ${msg}` };
    }
  },
};
