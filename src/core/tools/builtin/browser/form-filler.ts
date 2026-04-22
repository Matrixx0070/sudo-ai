/**
 * @file form-filler.ts
 * @description browser.fill-form — fill an HTML form from a data map and
 * optionally submit it.
 *
 * The tool iterates over the data map, locating each field by name/id
 * attribute or explicit selector key syntax (selector::<css>) and fills
 * with the appropriate method based on element type.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

export const formFillerTool: ToolDefinition = {
  name: 'browser.fill-form',
  description:
    'Fill a form on the current browser page from a data map. Keys can be field names, ' +
    'ids, or "selector::<css>" for explicit targeting. Optionally submits after filling.',
  category: 'browser',
  timeout: 30_000,
  parameters: {
    data: {
      type: 'object',
      required: true,
      description: 'Map of field identifier → value to fill.',
      properties: {},
    },
    formSelector: {
      type: 'string',
      required: false,
      description: 'CSS selector for the form element to scope field lookups within.',
    },
    submitAfterFill: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true, submits the form after filling all fields.',
    },
    submitSelector: {
      type: 'string',
      required: false,
      description: 'CSS selector for submit button. Defaults to [type="submit"] within the form.',
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

    const rawData = params['data'];
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      return { success: false, output: 'browser.fill-form: "data" must be an object.' };
    }
    const data = rawData as Record<string, string>;

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const formSelector = typeof params['formSelector'] === 'string' ? params['formSelector'] : null;
    const submitAfterFill = params['submitAfterFill'] === true;
    const submitSelector = typeof params['submitSelector'] === 'string'
      ? params['submitSelector']
      : '[type="submit"]';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    const filled: string[] = [];
    const failed: Array<{ field: string; reason: string }> = [];

    try {
      for (const [field, value] of Object.entries(data)) {
        let selector: string;

        if (field.startsWith('selector::')) {
          // Explicit CSS selector
          selector = field.replace(/^selector::/, '');
        } else {
          // Locate by name or id attribute within form scope
          const scope = formSelector ? `${formSelector} ` : '';
          selector = `${scope}[name="${field}"], ${scope}[id="${field}"]`;
        }

        try {
          const locator = page.locator(selector).first();
          const tagName = await locator.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => 'input');

          if (tagName === 'select') {
            await locator.selectOption({ label: value });
          } else if (tagName === 'input') {
            const type = await locator.evaluate((el: Element) => (el as HTMLInputElement).type).catch(() => 'text');
            if (type === 'checkbox') {
              const checked = value === 'true' || value === '1';
              if (checked) {
                await locator.check();
              } else {
                await locator.uncheck();
              }
            } else if (type === 'radio') {
              await locator.check();
            } else {
              await locator.fill(value);
            }
          } else {
            await locator.fill(value);
          }

          filled.push(field);
        } catch (fieldErr) {
          const reason = fieldErr instanceof Error ? fieldErr.message : String(fieldErr);
          failed.push({ field, reason });
          ctxLog.error({ tool: 'browser.fill-form', field, reason }, 'Field fill failed');
        }
      }

      if (submitAfterFill && filled.length > 0) {
        const submitScope = formSelector ? `${formSelector} ${submitSelector}` : submitSelector;
        await page.locator(submitScope).first().click();
        await page.waitForLoadState('domcontentloaded');
      }

      ctxLog.info({ tool: 'browser.fill-form', filled: filled.length, failed: failed.length }, 'Form fill complete');
      return {
        success: failed.length === 0,
        output:
          `Filled ${filled.length} fields.` +
          (failed.length > 0 ? ` Failed ${failed.length}: ${failed.map((f) => f.field).join(', ')}` : '') +
          (submitAfterFill ? ' Form submitted.' : ''),
        data: { filled, failed, submitted: submitAfterFill && failed.length === 0 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.fill-form', err }, 'Form fill error');
      return { success: false, output: `browser.fill-form error: ${msg}` };
    }
  },
};
