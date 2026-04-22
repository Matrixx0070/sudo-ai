/**
 * @file file-upload.ts
 * @description browser.file_upload — set files on a file input element.
 *
 * Uses Playwright's page.setInputFiles() which works with both visible and
 * hidden file inputs. All paths must be absolute or relative to the agent's
 * working directory. Multiple files are supported for multi-file inputs.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const fileUploadTool: ToolDefinition = {
  name: 'browser.file_upload',
  description:
    'Upload one or more files to a file input element on the current browser page. ' +
    'Paths may be absolute or relative to the working directory. ' +
    'Works with visible and hidden <input type="file"> elements.',
  category: 'browser',
  timeout: 60_000,
  parameters: {
    selector: {
      type: 'string',
      required: true,
      description:
        'CSS or Playwright selector targeting the <input type="file"> element. ' +
        'Example: "input[type=file]", "#avatar-upload".',
    },
    paths: {
      type: 'array',
      required: true,
      items: {
        type: 'string',
        description: 'Absolute or relative path to a local file to upload.',
      },
      description: 'List of file paths to attach to the input.',
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
      default: 5000,
      description: 'Milliseconds to wait for the file input element (default: 5000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const selector = params['selector'];
    if (typeof selector !== 'string' || selector.trim() === '') {
      return { success: false, output: 'browser.file_upload: "selector" is required.' };
    }

    const rawPaths = params['paths'];
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return {
        success: false,
        output: 'browser.file_upload: "paths" must be a non-empty array of file paths.',
      };
    }

    // Validate each path is a string and resolve to absolute
    const resolvedPaths: string[] = [];
    for (const p of rawPaths) {
      if (typeof p !== 'string' || p.trim() === '') {
        return {
          success: false,
          output: `browser.file_upload: all entries in "paths" must be non-empty strings. Got: ${JSON.stringify(p)}`,
        };
      }
      const abs = resolve(ctx.workingDir, p);
      if (!existsSync(abs)) {
        return {
          success: false,
          output: `browser.file_upload: file not found — "${abs}".`,
        };
      }
      resolvedPaths.push(abs);
    }

    const browserName =
      typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const timeout =
      typeof params['timeout'] === 'number' ? params['timeout'] : 5_000;

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output:
          `browser.file_upload: no browser instance named "${browserName}" found. ` +
          'Use browser.launch first.',
      };
    }

    const pages = instance.context.pages();
    const page =
      pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      await page.setInputFiles(selector, resolvedPaths, { timeout });

      ctxLog.info(
        { tool: 'browser.file_upload', selector, fileCount: resolvedPaths.length, browserName },
        'Files uploaded',
      );

      return {
        success: true,
        output:
          `Uploaded ${resolvedPaths.length} file(s) to "${selector}":\n` +
          resolvedPaths.map((p) => `  ${p}`).join('\n'),
        data: { selector, paths: resolvedPaths, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.file_upload', selector, err }, 'File upload failed');
      return { success: false, output: `browser.file_upload error: ${msg}` };
    }
  },
};
