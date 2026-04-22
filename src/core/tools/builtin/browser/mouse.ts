/**
 * @file mouse.ts
 * @description browser.mouse — coordinate-based mouse actions on the browser.
 *
 * Uses x,y coordinates exactly like OpenAI's computer-use tool:
 *   click(x, y) → page.mouse.click(x, y)
 *   double_click(x, y) → page.mouse.dblclick(x, y)
 *   move(x, y) → page.mouse.move(x, y)
 *   drag(from_x, from_y, to_x, to_y)
 *   scroll(x, y, delta_x, delta_y) → mouse.move + page.evaluate(scrollBy)
 *
 * Use browser.screenshot first to see the page and determine coordinates.
 * Use browser.click for selector-based clicking (more robust when available).
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager } from './browser-manager.js';

type MouseAction = 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll' | 'keypress' | 'type';
const VALID_ACTIONS: MouseAction[] = ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'keypress', 'type'];

export const mouseTool: ToolDefinition = {
  name: 'browser.mouse',
  description:
    'Coordinate-based mouse and keyboard actions. Use when CSS selectors are unavailable or after ' +
    'taking a screenshot to identify exact pixel positions. Actions: click, double_click, right_click, ' +
    'move, drag, scroll, keypress, type. Always take a screenshot first to get correct coordinates.',
  category: 'browser',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: VALID_ACTIONS,
      description: 'Action to perform: click, double_click, right_click, move, drag, scroll, keypress, type.',
    },
    x: {
      type: 'number',
      required: false,
      description: 'X coordinate in pixels. Required for click, double_click, right_click, move, drag, scroll.',
    },
    y: {
      type: 'number',
      required: false,
      description: 'Y coordinate in pixels. Required for click, double_click, right_click, move, drag, scroll.',
    },
    to_x: {
      type: 'number',
      required: false,
      description: 'Destination X coordinate. Required for drag.',
    },
    to_y: {
      type: 'number',
      required: false,
      description: 'Destination Y coordinate. Required for drag.',
    },
    delta_x: {
      type: 'number',
      required: false,
      default: 0,
      description: 'Horizontal scroll delta in pixels (for scroll action). Positive = right.',
    },
    delta_y: {
      type: 'number',
      required: false,
      default: 300,
      description: 'Vertical scroll delta in pixels (for scroll action). Positive = down.',
    },
    key: {
      type: 'string',
      required: false,
      description: 'Key to press (for keypress action). Examples: "Enter", "Tab", "Escape", "ArrowDown", "Control+a".',
    },
    text: {
      type: 'string',
      required: false,
      description: 'Text to type (for type action). Types character by character at current focus.',
    },
    button: {
      type: 'string',
      required: false,
      default: 'left',
      enum: ['left', 'right', 'middle'],
      description: 'Mouse button (default: "left").',
    },
    browser: {
      type: 'string',
      required: false,
      default: 'default',
      description: 'Named browser instance (default: "default").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as {
      info: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
    };

    const action = params['action'];
    if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as MouseAction)) {
      return { success: false, output: `browser.mouse: "action" must be one of: ${VALID_ACTIONS.join(', ')}.` };
    }

    const browserName = typeof params['browser'] === 'string' ? params['browser'] : 'default';
    const x = typeof params['x'] === 'number' ? params['x'] : null;
    const y = typeof params['y'] === 'number' ? params['y'] : null;
    const toX = typeof params['to_x'] === 'number' ? params['to_x'] : null;
    const toY = typeof params['to_y'] === 'number' ? params['to_y'] : null;
    const deltaX = typeof params['delta_x'] === 'number' ? params['delta_x'] : 0;
    const deltaY = typeof params['delta_y'] === 'number' ? params['delta_y'] : 300;
    const key = typeof params['key'] === 'string' ? params['key'] : null;
    const text = typeof params['text'] === 'string' ? params['text'] : null;
    const button = (typeof params['button'] === 'string' ? params['button'] : 'left') as 'left' | 'right' | 'middle';

    const manager = BrowserManager.getInstance();
    const instance = await manager.getOrConnect(browserName);
    if (!instance) {
      return {
        success: false,
        output: `browser.mouse: no browser instance "${browserName}". Use browser.launch first.`,
      };
    }

    const pages = instance.context.pages();
    const page = pages.length > 0 ? pages[pages.length - 1]! : await instance.context.newPage();

    try {
      switch (action as MouseAction) {
        case 'click': {
          if (x === null || y === null) return { success: false, output: 'browser.mouse: x and y required for click.' };
          await page.mouse.click(x, y, { button });
          ctxLog.info({ tool: 'browser.mouse', action, x, y, button }, 'Mouse clicked');
          return { success: true, output: `Clicked at (${x}, ${y}) with ${button} button.`, data: { x, y, button } };
        }

        case 'double_click': {
          if (x === null || y === null) return { success: false, output: 'browser.mouse: x and y required for double_click.' };
          await page.mouse.dblclick(x, y, { button });
          ctxLog.info({ tool: 'browser.mouse', action, x, y }, 'Mouse double-clicked');
          return { success: true, output: `Double-clicked at (${x}, ${y}).`, data: { x, y } };
        }

        case 'right_click': {
          if (x === null || y === null) return { success: false, output: 'browser.mouse: x and y required for right_click.' };
          await page.mouse.click(x, y, { button: 'right' });
          ctxLog.info({ tool: 'browser.mouse', action, x, y }, 'Mouse right-clicked');
          return { success: true, output: `Right-clicked at (${x}, ${y}).`, data: { x, y } };
        }

        case 'move': {
          if (x === null || y === null) return { success: false, output: 'browser.mouse: x and y required for move.' };
          await page.mouse.move(x, y);
          ctxLog.info({ tool: 'browser.mouse', action, x, y }, 'Mouse moved');
          return { success: true, output: `Mouse moved to (${x}, ${y}).`, data: { x, y } };
        }

        case 'drag': {
          if (x === null || y === null || toX === null || toY === null) {
            return { success: false, output: 'browser.mouse: x, y, to_x, to_y required for drag.' };
          }
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(toX, toY, { steps: 10 });
          await page.mouse.up();
          ctxLog.info({ tool: 'browser.mouse', action, x, y, toX, toY }, 'Mouse dragged');
          return { success: true, output: `Dragged from (${x}, ${y}) to (${toX}, ${toY}).`, data: { x, y, toX, toY } };
        }

        case 'scroll': {
          if (x === null || y === null) return { success: false, output: 'browser.mouse: x and y required for scroll.' };
          await page.mouse.move(x, y);
          await page.evaluate(
            ({ dx, dy }: { dx: number; dy: number }) => window.scrollBy(dx, dy),
            { dx: deltaX, dy: deltaY },
          );
          ctxLog.info({ tool: 'browser.mouse', action, x, y, deltaX, deltaY }, 'Scrolled');
          return { success: true, output: `Scrolled at (${x}, ${y}) by (${deltaX}, ${deltaY}).`, data: { x, y, deltaX, deltaY } };
        }

        case 'keypress': {
          if (!key) return { success: false, output: 'browser.mouse: "key" required for keypress.' };
          await page.keyboard.press(key);
          ctxLog.info({ tool: 'browser.mouse', action, key }, 'Key pressed');
          return { success: true, output: `Pressed key "${key}".`, data: { key } };
        }

        case 'type': {
          if (!text) return { success: false, output: 'browser.mouse: "text" required for type.' };
          await page.keyboard.type(text);
          ctxLog.info({ tool: 'browser.mouse', action, textLen: text.length }, 'Typed text');
          return { success: true, output: `Typed ${text.length} characters.`, data: { textLen: text.length } };
        }

        default:
          return ensureNever(action as never);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctxLog.error({ tool: 'browser.mouse', action, err }, 'Mouse action failed');
      return { success: false, output: `browser.mouse error: ${msg}` };
    }
  },
};

function ensureNever(_: never): ToolResult {
  return { success: false, output: 'browser.mouse: unknown action.' };
}
