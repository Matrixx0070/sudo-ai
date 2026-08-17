/**
 * @file perceive.ts
 * @description `computer.perceive` — structured, read-only perception of the
 * current display for the agent. Returns the accessibility elements (with stable
 * indices the model can then click by), the open windows, and optionally the
 * screenshot. This is the hybrid-perception front door: the model gets the cheap
 * structured AX view by default and asks for pixels only when it needs them.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { PerceptionService } from './core/perception.js';

const log = createLogger('tool:computer-perceive');

const KILL_SWITCH_ENV = 'SUDO_COMPUTER_USE_DISABLE';

/** Resolve the display the agent perceives: explicit param → env → the owner desktop. */
export function resolveDisplay(param?: unknown): string {
  if (typeof param === 'string' && param.trim()) return param.trim();
  return process.env['DISPLAY'] ?? ':10.0';
}

// One perception service is fine to share; it is stateless beyond a seq counter.
let perception: PerceptionService | undefined;
function getPerception(): PerceptionService {
  if (!perception) perception = new PerceptionService({ accessibility: true });
  return perception;
}

export const perceiveTool: ToolDefinition = {
  name: 'computer.perceive',
  description:
    'Perceive the current screen as structured data: a list of accessibility elements (each with a stable index, role, name, and pixel box), the open windows, and optionally the screenshot. Use the element index with computer.click grounding, or read the screenshot when structure is insufficient.',
  category: 'computer',
  safety: 'readonly',
  timeout: 15_000,
  parameters: {
    display: { type: 'string', required: false, description: 'X display to perceive (defaults to the active display).' },
    include_screenshot: { type: 'boolean', required: false, description: 'Include the base64 PNG screenshot in data (default false — larger).' },
    max_elements: { type: 'number', required: false, description: 'Cap on returned accessibility elements (default 120).' },
  },
  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (process.env[KILL_SWITCH_ENV] === '1') {
      return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };
    }
    const display = resolveDisplay(params['display']);
    const cap = typeof params['max_elements'] === 'number' ? Math.max(1, params['max_elements'] as number) : 120;
    const includeShot = params['include_screenshot'] === true;

    try {
      const snap = await getPerception().capture(display);
      const elements = snap.elements.slice(0, cap).map((e) => ({ i: e.i, role: e.role, name: e.name, x: e.x, y: e.y, w: e.w, h: e.h }));
      const windows = snap.windows.map((w) => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, active: w.active }));
      const data: Record<string, unknown> = {
        display,
        dimensions: { width: snap.width, height: snap.height },
        axAvailable: snap.axAvailable,
        elements,
        windows,
      };
      if (includeShot) {
        data['screenshot'] = snap.screenshot;
        data['mimeType'] = 'image/png';
      }
      const activeTitle = windows.find((w) => w.active)?.title ?? '(none)';
      return {
        success: true,
        output: `perceived ${display}: ${elements.length} elements, ${windows.length} windows, active="${activeTitle}"${snap.axAvailable ? '' : ' (no accessibility tree — pixel grounding only)'}`,
        data,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ err: msg, display }, 'computer.perceive failed');
      return { success: false, output: `computer.perceive failed: ${msg}` };
    }
  },
};
