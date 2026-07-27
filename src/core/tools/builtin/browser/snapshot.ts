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
import { resolveActivePage } from './active-page.js';
import { captureStableRefs } from './stable-ref.js';

/**
 * The ARIA tree is capped to this many chars when a ref listing is present, so the
 * actionable refs (placed first) always survive the tool-output clamp (~24KB, keeps
 * the head). The refs are what the model acts on; the tree is secondary context.
 */
const ARIA_TREE_PREVIEW_CHARS = 6000;

export const snapshotTool: ToolDefinition = {
  name: 'browser.snapshot',
  description:
    'Capture an ARIA accessibility snapshot of the current browser page. ' +
    'Returns a YAML-formatted tree of all visible roles, names, and values — ' +
    'use this to identify selectors and understand page structure without a screenshot. ' +
    'The tree reflects DOM order, NOT scroll position — scrolling the page and re-calling ' +
    'this tool returns the same content. On a long page, pass "selector" scoped to the ' +
    'section you need (e.g. "#pricing", ".pricing-table") instead of scrolling and retrying.',
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
    refs: {
      type: 'boolean',
      required: false,
      default: true,
      description:
        'Also stamp stable numeric refs onto actionable elements and include a ' +
        '"[N] role name" listing. Pass these refs to browser.click / browser.type ' +
        'via their "ref" param for exact, duplicate-name-proof targeting (default: true).',
    },
    selector: {
      type: 'string',
      required: false,
      description:
        'CSS selector to scope the snapshot to (e.g. "#pricing", ".pricing-table"). ' +
        'Use this on long pages instead of scrolling — ariaSnapshot() reflects DOM order, ' +
        'not scroll position, so scrolling never changes an unscoped snapshot\'s content. ' +
        'Defaults to the whole page ("body") when omitted.',
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
    const selector =
      typeof params['selector'] === 'string' && params['selector'].trim() !== ''
        ? params['selector'].trim()
        : null;

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

    const page = await resolveActivePage(instance);

    try {
      // ariaSnapshot() returns a YAML string describing the ARIA tree in DOM
      // order — it is NOT scroll-position-relative, so an unscoped snapshot on
      // a long page always returns the same head regardless of how much the
      // page has been scrolled. `selector` narrows the locator so a specific
      // section (e.g. one buried past the preview cap) can be read directly.
      const snapshot: string = await page
        .locator(selector ?? 'body')
        .ariaSnapshot({ timeout });

      const url = page.url();
      const title = await page.title().catch(() => '');
      const lineCount = snapshot.split('\n').length;

      // Stamp stable refs so click/type can target elements exactly, even when
      // several share the same accessible name. Non-fatal: a stamping failure
      // still returns the ARIA tree.
      const wantRefs = params['refs'] !== false;
      let refBlock = '';
      let refs: Array<Record<string, unknown>> = [];
      if (wantRefs) {
        try {
          const captured = await captureStableRefs(page);
          refs = captured.refs as unknown as Array<Record<string, unknown>>;
          refBlock =
            `Actionable elements (pass ref=N to browser.click / browser.type):\n${captured.render}`;
        } catch (refErr) {
          ctxLog.error({ tool: 'browser.snapshot', browserName, err: refErr }, 'Ref stamping failed');
        }
      }

      ctxLog.info(
        { tool: 'browser.snapshot', browserName, url, lineCount, refCount: refs.length },
        'Snapshot captured',
      );

      // Ordering matters: the ACTIONABLE ref listing must come FIRST so it lands
      // in the output-clamp's head (~19KB kept) and survives on large pages. On
      // Wikipedia-sized pages the ARIA tree alone is ~21KB and, if placed first,
      // pushes the ref list past the clamp — the model then can't see valid refs
      // and guesses. The full ARIA tree is secondary context once refs exist, so
      // it's capped to a preview after the refs.
      const scopeLabel = selector ? ` scoped to "${selector}"` : '';
      // This tree is DOM-order, not scroll-order — scrolling the page will NOT
      // change what a truncated, unscoped snapshot returns. Tell the model the
      // actual escape hatch (selector) instead of letting it retry scroll+
      // snapshot forever (observed doom loop: repeated scroll/re-snapshot on a
      // long page, because the truncated head never moved).
      const truncationHint = selector
        ? `\n…[ARIA tree truncated to ${ARIA_TREE_PREVIEW_CHARS} chars — narrow "${selector}" further or act via the ref list above]`
        : `\n…[ARIA tree truncated to ${ARIA_TREE_PREVIEW_CHARS} chars. This is DOM order, not scroll ` +
          'position — scrolling and re-snapshotting returns the same content. Pass browser.snapshot\'s ' +
          '"selector" param scoped to the section you need (e.g. "#pricing"), or act via the ref list above.]';

      let output: string;
      if (wantRefs && refBlock) {
        const tree = snapshot.length > ARIA_TREE_PREVIEW_CHARS
          ? snapshot.slice(0, ARIA_TREE_PREVIEW_CHARS) + truncationHint
          : snapshot;
        output = `Snapshot of "${title}" (${url})${scopeLabel}.\n\n${refBlock}\n\nARIA tree (structure preview):\n${tree}`;
      } else {
        // refs disabled or stamping failed — preserve the original full-tree shape.
        output = `ARIA snapshot of "${title}" (${url})${scopeLabel}:\n\n${snapshot}`;
      }

      return {
        success: true,
        output,
        data: { url, title, snapshot, lineCount, refs },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.snapshot', browserName, selector, err }, 'Snapshot failed');
      // A selector matching zero elements times out inside ariaSnapshot() with
      // a generic Playwright wait error — surface the likely cause explicitly
      // instead of letting the model mistake it for a page-load/network issue.
      const hint = selector && /timeout|exceeded/i.test(msg)
        ? ` (selector "${selector}" may not match any element on this page — try browser.snapshot without a selector first to see available sections)`
        : '';
      return { success: false, output: `browser.snapshot error: ${msg}${hint}` };
    }
  },
};
