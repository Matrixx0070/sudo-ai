/**
 * @file canvas-render.ts (canvas.render)
 * @description Generative UI / A2UI (Spec 2). The agent renders interactive UI —
 * charts, metrics, tables, forms, buttons — live to the user's web client instead
 * of describing it in text. Give a `components` array (closed schema); it's
 * validated server-side (unknown types/fields rejected — no XSS) and pushed to the
 * session's web panel over WebSocket. Buttons/forms come back as a typed
 * [CANVAS EVENT] injected into this session (see /v1/canvas/event).
 *
 * Web sessions only — on other channels it returns a clear reason so you fall
 * back to text.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { validateCanvasPayload } from '../../../canvas/schema.js';
import { pushCanvasToSession, isCanvasBridgeReady } from '../../../canvas/canvas-bridge.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.canvas-render');

export const canvasRenderTool: ToolDefinition = {
  name: 'canvas.render',
  description:
    'Render interactive UI to the user\'s web chat panel instead of describing it in text. '
    + 'Supported component types (closed set): text, metric, chart (bar/line/pie), table, form, '
    + 'button, progress, list. Buttons and forms send a typed event back into this session when '
    + 'the user clicks/submits, so you can react. Web chat only — returns a reason to fall back to '
    + 'text on other channels. Example components: '
    + '[{"type":"metric","label":"Revenue","value":"$4.6M","trend":"up"},'
    + '{"type":"chart","chartType":"bar","series":[{"label":"NA","value":42}]},'
    + '{"type":"form","submitActionId":"save","fields":[{"name":"email","label":"Email","kind":"text"}]}]',
  category: 'meta',
  parameters: {
    components: {
      type: 'array',
      required: true,
      description: 'Array of components (closed schema). Each has a "type" and its allowed fields only.',
    },
    title: { type: 'string', required: false, description: 'Optional panel title.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!isCanvasBridgeReady()) {
      return { success: false, output: 'canvas.render: UI bridge not available (no web gateway wired).' };
    }
    const validation = validateCanvasPayload({ components: params['components'], ...(typeof params['title'] === 'string' ? { title: params['title'] } : {}) });
    if (!validation.ok || !validation.payload) {
      return { success: false, output: `canvas.render: invalid components — ${validation.errors.slice(0, 5).join('; ')}` };
    }
    try {
      const r = await pushCanvasToSession(ctx.sessionId, validation.payload);
      if (!r.ok) {
        return { success: false, output: `canvas.render: not delivered — ${r.reason}. Fall back to a text summary.` };
      }
      logger.info({ session: ctx.sessionId, components: validation.payload.components.length }, 'canvas.render pushed');
      return {
        success: true,
        output: `Rendered ${validation.payload.components.length} component(s) to the web panel. `
          + 'If it contains buttons/forms, wait for the [CANVAS EVENT] before continuing.',
        data: { components: validation.payload.components.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, err: msg }, 'canvas.render failed');
      return { success: false, output: `canvas.render failed: ${msg}` };
    }
  },
};
