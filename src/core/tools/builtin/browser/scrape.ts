/**
 * @file scrape.ts
 * @description browser.scrape — extract structured data from the current page
 * via CSS selector maps and multiple extraction modes.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';

type ExtractAs = 'text' | 'html' | 'links' | 'table';
const VALID_MODES: ExtractAs[] = ['text', 'html', 'links', 'table'];

// Playwright's locator.innerText()/innerHTML() default to a ~30s actionability
// wait when a selector matches nothing, and the per-key loop below used to
// swallow that into a bare `null` via `.catch(() => null)` — a model guessing
// wrong CSS selectors burned ~30s PER WRONG GUESS with no signal about which
// selector failed, and the tool still reported `success: true`. This bounds
// each lookup to a short, fail-fast window instead of Playwright's default.
const SELECTOR_LOOKUP_TIMEOUT_MS = 5_000;

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

    const page = await resolveActivePage(instance);

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

      // No selectors + text/html would loop zero times and report a
      // 0-field "success" — the silent no-op behind the 2026-07-24 HN
      // incident. Fail with directions instead.
      if (Object.keys(selectors).length === 0) {
        return {
          success: false,
          output:
            'browser.scrape: no selectors provided. Pass selectors as an OBJECT map of ' +
            'field→CSS-selector (e.g. {"titles": ".titleline"}), or use extractAs:"links" / ' +
            '"table" for whole-page extraction without selectors.',
        };
      }

      // Selector-based extraction. failedKeys tracks which field selectors
      // matched nothing, so the caller (model) gets an honest, actionable
      // signal instead of a "success" full of silent nulls.
      const failedKeys: string[] = [];
      for (const [key, selector] of Object.entries(selectors)) {
        const fullSelector = containerSelector ? `${containerSelector} ${selector}` : selector;

        try {
          switch (extractAs) {
            case 'text':
              results[key] = await page.locator(fullSelector).first()
                .innerText({ timeout: SELECTOR_LOOKUP_TIMEOUT_MS });
              break;
            case 'html':
              results[key] = await page.locator(fullSelector).first()
                .innerHTML({ timeout: SELECTOR_LOOKUP_TIMEOUT_MS });
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
        } catch {
          // text/html: selector matched nothing (or stayed hidden) within the
          // lookup timeout. links/table use page.evaluate, which never throws
          // for a non-matching selector (querySelector[All] just returns
          // empty/null), so this branch is reached only by the locator paths.
          results[key] = null;
          failedKeys.push(key);
        }
      }

      const totalKeys = Object.keys(results).length;
      const allFailed = failedKeys.length === totalKeys;
      const output = allFailed
        ? `browser.scrape: none of the ${totalKeys} selector(s) matched an element: ` +
          `${failedKeys.join(', ')}. Take a browser.snapshot to see real selectors before retrying.`
        : failedKeys.length > 0
          ? `Extracted ${totalKeys - failedKeys.length}/${totalKeys} fields (mode: ${extractAs}). ` +
            `No match for: ${failedKeys.join(', ')}.`
          : `Extracted ${totalKeys} fields (mode: ${extractAs}).`;

      ctxLog.info(
        { tool: 'browser.scrape', extractAs, keys: Object.keys(results), failedKeys },
        'Scrape complete',
      );
      return {
        success: !allFailed,
        output,
        data: { results, url: page.url(), failedKeys },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.scrape', err }, 'Scrape failed');
      return { success: false, output: `browser.scrape error: ${msg}` };
    }
  },
};
