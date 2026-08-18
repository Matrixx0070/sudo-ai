/**
 * @file interact.ts
 * @description browser.interact — perform UI actions on the current page:
 * click, type, scroll, select, press, hover.
 */

import type { Locator } from 'playwright';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { parseRefParam, resolveStableRef, refNotFoundOutput } from './stable-ref.js';

type InteractAction = 'click' | 'type' | 'scroll' | 'select' | 'press' | 'hover';
const VALID_ACTIONS: InteractAction[] = ['click', 'type', 'scroll', 'select', 'press', 'hover'];

/**
 * Recover a stable ref the model wrote INTO the `selector` field.
 *
 * browser.snapshot emits `ref=N` handles and its instruction text says "pass
 * ref=N to browser.click / browser.type". The model routinely feeds those
 * same refs to browser.interact's `selector` — as `[ref=67]`, `[ref="4"]`,
 * `button[ref="5"]`, `ref=67`, or a bare `[5]` — none of which is a valid CSS
 * selector, so Playwright's locator throws a SyntaxError or times out. This
 * was the dominant cause of browser.interact's ~60% failure rate (measured
 * from the daemon error logs, 2026-08-17). Detecting the ref-shaped forms and
 * resolving them the same way click/type do closes that whole class.
 *
 * Deliberately strict: only selectors that are ENTIRELY a ref reference match,
 * so a legitimate attribute selector like `[data-ref="x"]` or `div[5]`-free
 * CSS is never misread.
 */
export function extractRefFromSelector(selector: string | null): number | null {
  if (!selector) return null;
  const s = selector.trim();
  // `[ref=67]`, `[ref="67"]`, optional tag prefix (`button[ref="5"]`)
  const attr = /^[a-zA-Z]*\[ref=["']?(\d+)["']?\]$/.exec(s);
  if (attr) return Number(attr[1]);
  // bare `[5]`
  const bracket = /^\[(\d+)\]$/.exec(s);
  if (bracket) return Number(bracket[1]);
  // `ref=67`
  const bare = /^ref=(\d+)$/.exec(s);
  if (bare) return Number(bare[1]);
  return null;
}

export const interactTool: ToolDefinition = {
  name: 'browser.interact',
  description:
    'Interact with the current browser page. Actions: click (element), type (text into field), ' +
    'scroll (window or element), select (dropdown), press (keyboard key), hover (element).',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: VALID_ACTIONS,
      description: 'Action to perform.',
    },
    ref: {
      type: 'number',
      required: false,
      description:
        'Stable element ref from a prior browser.snapshot (e.g. 12) — PREFERRED and ' +
        'duplicate-name-proof. Use this instead of guessing a CSS selector.',
    },
    selector: {
      type: 'string',
      required: false,
      description:
        'CSS/text selector to target. Prefer "ref" from browser.snapshot. ' +
        'A ref written here (e.g. "ref=12" or "[ref=12]") is auto-resolved.',
    },
    text: {
      type: 'string',
      required: false,
      description: 'Text to type (for "type" action) or option to select (for "select" action).',
    },
    key: {
      type: 'string',
      required: false,
      description: 'Key to press, e.g. "Enter", "Tab", "Escape" (for "press" action).',
    },
    scrollX: {
      type: 'number',
      required: false,
      default: 0,
      description: 'Horizontal scroll distance in pixels (for "scroll" action).',
    },
    scrollY: {
      type: 'number',
      required: false,
      default: 300,
      description: 'Vertical scroll distance in pixels (for "scroll" action).',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
    timeout: {
      type: 'number',
      required: false,
      default: 10000,
      description: 'Timeout in milliseconds for the action (default: 10000).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const action = params['action'];
    if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as InteractAction)) {
      return {
        success: false,
        output: `browser.interact: "action" must be one of: ${VALID_ACTIONS.join(', ')}.`,
      };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const selector = typeof params['selector'] === 'string' ? params['selector'] : null;
    const text = typeof params['text'] === 'string' ? params['text'] : null;
    const key = typeof params['key'] === 'string' ? params['key'] : null;
    const scrollX = typeof params['scrollX'] === 'number' ? params['scrollX'] : 0;
    const scrollY = typeof params['scrollY'] === 'number' ? params['scrollY'] : 300;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10_000;

    // Prefer an explicit ref; else recover one the model wrote into `selector`.
    const ref = parseRefParam(params['ref']) ?? extractRefFromSelector(selector);

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const page = await resolveActivePage(instance);

    /**
     * Resolve the target Locator for an action that needs one. A ref (explicit
     * or recovered from `selector`) is resolved via the stable-ref map — the
     * same path browser.click/type use — otherwise the raw selector is used.
     * Returns a ToolResult on failure so the caller can early-return.
     */
    async function targetLocator(): Promise<{ locator: Locator } | { error: ToolResult }> {
      if (ref !== null) {
        const locator = await resolveStableRef(page, ref);
        if (!locator) {
          return { error: { success: false, output: await refNotFoundOutput(page, ref, 'browser.interact') } };
        }
        return { locator };
      }
      if (!selector) {
        return { error: { success: false, output: `browser.interact: "ref" or "selector" required for ${action}.` } };
      }
      return { locator: page.locator(selector).first() };
    }

    try {
      switch (action as InteractAction) {
        case 'click': {
          const t = await targetLocator();
          if ('error' in t) return t.error;
          await t.locator.click({ timeout });
          break;
        }
        case 'type': {
          if (!text) return { success: false, output: 'browser.interact: "text" required for type.' };
          const t = await targetLocator();
          if ('error' in t) return t.error;
          await t.locator.fill(text, { timeout });
          break;
        }
        case 'scroll': {
          if (ref !== null || selector) {
            const t = await targetLocator();
            if ('error' in t) return t.error;
            await t.locator.scrollIntoViewIfNeeded({ timeout });
          } else {
            await page.evaluate(({ x, y }: { x: number; y: number }) => window.scrollBy(x, y), { x: scrollX, y: scrollY });
          }
          break;
        }
        case 'select': {
          if (!text) return { success: false, output: 'browser.interact: "text" required for select.' };
          const t = await targetLocator();
          if ('error' in t) return t.error;
          await t.locator.selectOption({ label: text }, { timeout });
          break;
        }
        case 'press': {
          if (!key) return { success: false, output: 'browser.interact: "key" required for press.' };
          if (ref !== null || selector) {
            const t = await targetLocator();
            if ('error' in t) return t.error;
            await t.locator.press(key, { timeout });
          } else {
            await page.keyboard.press(key);
          }
          break;
        }
        case 'hover': {
          const t = await targetLocator();
          if ('error' in t) return t.error;
          await t.locator.hover({ timeout });
          break;
        }
      }

      const targetDesc = ref !== null ? `ref=${ref}` : selector ? `"${selector}"` : '';
      ctxLog.info({ tool: 'browser.interact', action, ref: ref ?? undefined, selector }, 'Action performed');
      return {
        success: true,
        output: `Action "${action}" completed${targetDesc ? ` on ${targetDesc}` : ''}.`,
        data: { action, ref: ref ?? undefined, selector, text, key },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.interact', action, ref: ref ?? undefined, selector, err }, 'Action failed');
      const isTimeout = msg.includes('Timeout') || msg.includes('timeout');
      const hint = isTimeout
        ? `\n\nRECOVERY REQUIRED: the target was not found or timed out.\n` +
          `MANDATORY NEXT STEP: Call browser.snapshot NOW to refresh stable refs, ` +
          `then retry browser.interact with the correct ref=N (pass it as the "ref" param).\n` +
          `NOTE: prefer ref over a guessed CSS selector; text= selectors are case-sensitive.`
        : '';
      return { success: false, output: `browser.interact error: ${msg}${hint}` };
    }
  },
};
