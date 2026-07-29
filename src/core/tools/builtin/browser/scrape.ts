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

/**
 * Cap on selector-less whole-page extraction. Long enough for a full article
 * (the Apollo 11 page is ~90k chars) without letting one scrape blow the
 * context window; the output says when it truncated and how to narrow.
 */
const MAX_WHOLE_PAGE_CHARS = 40_000;

export const scrapeTool: ToolDefinition = {
  name: 'browser.scrape',
  description:
    'Extract data from the current browser page. ' +
    'To READ THE PAGE (e.g. answer a question about an article), call it with NO selectors — ' +
    'that returns the whole page text. Do NOT guess CSS selectors for a page you have not ' +
    'inspected; take a browser.snapshot first if you need specific fields. ' +
    'Provide a map of key→CSS-selector pairs only to extract known structured fields. ' +
    'extractAs controls output format: text (inner text, default), html (innerHTML), ' +
    'links (href list), table (2D array of cell text). ' +
    'containerSelector scopes extraction to one section.',
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

      // No selectors + text/html: extract the WHOLE PAGE, the same way links
      // and table already do in this position.
      //
      // This used to hard-fail with "pass selectors", which closed the only
      // honest answer to "what does this page say" — no tool returned page
      // prose (browser.snapshot returns an ARIA/YAML tree for FINDING
      // selectors, not content). A model asked to read an article therefore
      // had to INVENT CSS selectors for a page it cannot see. 2026-07-29:
      // asked for the Apollo 11 launch date it guessed the selector
      // `launchDate`, matched nothing, and answered from the page title
      // instead — a correct answer on no evidence, which is the dangerous
      // failure mode, not the visible one.
      //
      // NOT a return of the 2026-07-24 silent no-op: that reported a 0-field
      // extraction as success. This returns real content and still fails
      // loudly when the page genuinely has none.
      if (Object.keys(selectors).length === 0 && (extractAs === 'text' || extractAs === 'html')) {
        const root = containerSelector ?? 'body';
        const whole = await page.evaluate(
          ([sel, mode]) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return mode === 'html' ? el.innerHTML : (el as HTMLElement).innerText;
          },
          [root, extractAs] as [string, string],
        );
        if (whole === null) {
          return { success: false, output: `browser.scrape: containerSelector "${root}" matched no element.` };
        }
        const text = whole.trim();
        if (text === '') {
          return {
            success: false,
            output:
              `browser.scrape: "${root}" contained no ${extractAs}. The page may still be loading ` +
              '(browser.wait) or render inside an iframe.',
          };
        }
        const truncated = text.length > MAX_WHOLE_PAGE_CHARS;
        const body = truncated ? text.slice(0, MAX_WHOLE_PAGE_CHARS) : text;
        ctxLog.info(
          { tool: 'browser.scrape', extractAs, wholePage: true, chars: text.length, truncated },
          'Scrape complete (whole page)',
        );
        return {
          success: true,
          output:
            `Extracted ${text.length} chars of ${extractAs} from "${root}"` +
            (truncated ? ` (truncated to ${MAX_WHOLE_PAGE_CHARS} — pass selectors or containerSelector to narrow)` : '') +
            `:\n\n${body}`,
          data: { text: body, chars: text.length, truncated, url: page.url() },
        };
      }

      // links/table with no selectors are handled above. Anything else would
      // loop zero times and report a 0-field "success" — the silent no-op
      // behind the 2026-07-24 HN incident. Fail with directions instead.
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
