/**
 * @file scrape.ts
 * @description browser.scrape — extract structured data from the current page
 * via CSS selector maps and multiple extraction modes.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

type ExtractAs = 'text' | 'html' | 'links' | 'table';
const VALID_MODES: ExtractAs[] = ['text', 'html', 'links', 'table'];

export const scrapeTool: ToolDefinition = {
  name: 'browser.scrape',
  description:
    'Extract data from the current browser page. Provide a map of key→CSS-selector pairs to ' +
    'extract multiple fields. extractAs controls output format: text (inner text), html (innerHTML), ' +
    'links (href list), table (2D array of cell text).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    selectors: {
      type: 'object',
      required: false,
      description: 'Map of field name → CSS selector. Each entry extracts one element.',
      properties: {},
    },
    extractAs: {
      type: 'string',
      required: false,
      default: 'text',
      enum: VALID_MODES,
      description: 'Extraction mode: text | html | links | table.',
    },
    containerSelector: {
      type: 'string',
      required: false,
      description: 'Optional root selector to scope all extraction within.',
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

    const extractAs: ExtractAs =
      VALID_MODES.includes(params['extractAs'] as ExtractAs)
        ? (params['extractAs'] as ExtractAs)
        : 'text';

    const rawSelectors = params['selectors'];
    const selectors: Record<string, string> =
      rawSelectors && typeof rawSelectors === 'object' && !Array.isArray(rawSelectors)
        ? (rawSelectors as Record<string, string>)
        : {};

    const containerSelector =
      typeof params['containerSelector'] === 'string' ? params['containerSelector'] : null;
    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      const results: Record<string, unknown> = {};

      // If no selectors provided and mode is 'links', extract all page links.
      if (Object.keys(selectors).length === 0 && extractAs === 'links') {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            text: (a as HTMLAnchorElement).textContent?.trim() ?? '',
            href: (a as HTMLAnchorElement).href,
          })),
        );
        return {
          success: true,
          output: `Extracted ${links.length} links from page.`,
          data: { links, url: page.url() },
        };
      }

      // If no selectors and mode is 'table', extract first table on page.
      if (Object.keys(selectors).length === 0 && extractAs === 'table') {
        const table = await page.evaluate(() => {
          const tbl = document.querySelector('table');
          if (!tbl) return null;
          return Array.from(tbl.querySelectorAll('tr')).map((row) =>
            Array.from(row.querySelectorAll('td,th')).map(
              (cell) => (cell as HTMLElement).textContent?.trim() ?? '',
            ),
          );
        });
        return {
          success: true,
          output: table ? `Extracted table with ${table.length} rows.` : 'No table found on page.',
          data: { table, url: page.url() },
        };
      }

      // Selector-based extraction
      for (const [key, selector] of Object.entries(selectors)) {
        const fullSelector = containerSelector ? `${containerSelector} ${selector}` : selector;

        switch (extractAs) {
          case 'text':
            results[key] = await page.locator(fullSelector).first().innerText().catch(() => null);
            break;
          case 'html':
            results[key] = await page.locator(fullSelector).first().innerHTML().catch(() => null);
            break;
          case 'links':
            results[key] = await page.evaluate((sel: string) =>
              Array.from(document.querySelectorAll(sel)).map((a) => ({
                text: (a as HTMLAnchorElement).textContent?.trim() ?? '',
                href: (a as HTMLAnchorElement).href,
              })),
            fullSelector);
            break;
          case 'table':
            results[key] = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              return Array.from(el.querySelectorAll('tr')).map((row) =>
                Array.from(row.querySelectorAll('td,th')).map(
                  (cell) => (cell as HTMLElement).textContent?.trim() ?? '',
                ),
              );
            }, fullSelector);
            break;
        }
      }

      ctxLog.info({ tool: 'browser.scrape', extractAs, keys: Object.keys(results) }, 'Scrape complete');
      return {
        success: true,
        output: `Extracted ${Object.keys(results).length} fields (mode: ${extractAs}).`,
        data: { results, url: page.url() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.scrape', err }, 'Scrape failed');
      return { success: false, output: `browser.scrape error: ${msg}` };
    }
  },
};
