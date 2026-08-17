/**
 * @file index.ts
 * @description Registered `computer.*` tool family — the agent-facing surface of
 * the Computer Use Backend, backed by the cross-platform {@link IComputerUse}
 * abstraction (see ./cross-platform/).
 *
 * ## Consolidation (Phase 0)
 *
 * This replaces the older `computer.use` tool that lived in
 * `browser/computer-use-tool.ts`. Per the engineering doctrine there is now ONE
 * computer-use path: every screen/input/window action flows through
 * `createComputerUse()` → the platform driver. The low-level primitive
 * (`browser/computer-use.ts::executeComputerAction`) is still the Linux
 * mechanism; the cross-platform layer wraps it and adds the outcome learner,
 * kill-switch, and window guard.
 *
 * ## Surface
 *
 * The family exposes ONLY the genuinely-new capability — screen perception,
 * synthetic input, and window/desktop management. It deliberately does NOT
 * re-expose exec/file: `system.exec` and the `coder.*` file tools already own
 * those, and duplicating them would violate the simplicity rule.
 *
 *   computer.screenshot  — capture the screen (read-only)
 *   computer.click       — click at pixel (x,y)
 *   computer.type        — type literal text
 *   computer.key         — press a key / chord (e.g. Return, ctrl+c)
 *   computer.scroll      — scroll up/down
 *   computer.window      — list / focus / open windows & apps
 *
 * ## Gating
 *
 *   - Authority: every MUTATING action calls `authorize()` (the single
 *     execution-authority resolver). In gated mode the surface would prompt;
 *     in autonomous mode it proceeds. Screenshot is read-only and skips it.
 *   - Kill-switch: `SUDO_COMPUTER_USE_DISABLE=1` hard-stops the whole family
 *     (checked inside the driver too). The predecessor `computer.use` was
 *     always-on, so the family stays on by default and the flag is the
 *     operational off-switch — capability preserved, per doctrine.
 *   - Window guard: the Linux driver blocks mutating actions when a
 *     Terminal/Claude window is focused (MEMORY.md isolation rule).
 */

import { createLogger } from '../../../shared/logger.js';
import { authorize } from '../../../security/execution-authority.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createComputerUse } from './cross-platform/index.js';
import type { IComputerUse } from './cross-platform/index.js';
import { perceiveTool } from './perceive.js';

const log = createLogger('tool:computer');

/** Hard kill-switch env for the whole family (also honoured inside the driver). */
const KILL_SWITCH_ENV = 'SUDO_COMPUTER_USE_DISABLE';

// ---------------------------------------------------------------------------
// Lazy driver singleton
// ---------------------------------------------------------------------------

let driver: IComputerUse | undefined;

/**
 * Construct the platform driver lazily on first use. Kept out of module load so
 * importing this file (e.g. during tool registration) never touches the display
 * or spawns anything — the hot path stays light.
 */
function getDriver(): IComputerUse {
  if (!driver) {
    driver = createComputerUse({ killSwitchEnv: KILL_SWITCH_ENV });
  }
  return driver;
}

/** Test seam: inject a fake driver. */
export function __setComputerUseDriverForTest(d: IComputerUse | undefined): void {
  driver = d;
}

function killSwitchActive(): boolean {
  return process.env[KILL_SWITCH_ENV] === '1';
}

/**
 * Gate a mutating action through the execution-authority resolver. Returns a
 * failure ToolResult when the action must not proceed, otherwise null.
 */
function gateMutation(action: string, ctx: ToolContext): ToolResult | null {
  if (killSwitchActive()) {
    return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };
  }
  const decision = authorize({
    surface: 'agent-tool',
    action,
    ownerVerified: ctx.isOwner === true,
  });
  if (!decision.proceed) {
    return {
      success: false,
      output:
        decision.requiresPrompt
          ? `computer: ${action} requires confirmation (authority mode: ${decision.mode})`
          : `computer: ${action} refused (${decision.reason})`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const screenshotTool: ToolDefinition = {
  name: 'computer.screenshot',
  description:
    'Capture a screenshot of the current display and return it as a base64 PNG (in data.screenshot). Read-only — use this to see the screen before acting.',
  category: 'computer',
  safety: 'readonly',
  timeout: 15_000,
  parameters: {},
  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (killSwitchActive()) {
      return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };
    }
    const res = await getDriver().gui({ action: 'screenshot' });
    if (!res.success) {
      return { success: false, output: res.error ?? 'computer.screenshot failed' };
    }
    return {
      success: true,
      output: 'screenshot captured',
      data: { screenshot: res.screenshot ?? '', mimeType: 'image/png' },
    };
  },
};

const clickTool: ToolDefinition = {
  name: 'computer.click',
  description: 'Click the mouse at pixel coordinates (x, y) on the current display.',
  category: 'computer',
  safety: 'destructive',
  timeout: 15_000,
  parameters: {
    x: { type: 'number', required: true, description: 'X coordinate in pixels.' },
    y: { type: 'number', required: true, description: 'Y coordinate in pixels.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = gateMutation('computer.click', ctx);
    if (gate) return gate;
    const x = params['x'];
    const y = params['y'];
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { success: false, output: 'computer.click: numeric x and y are required.' };
    }
    const res = await getDriver().gui({ action: 'click', x, y });
    return { success: res.success, output: res.error ?? `computer.click(${x},${y}) OK` };
  },
};

const typeTool: ToolDefinition = {
  name: 'computer.type',
  description: 'Type literal text into the focused element on the current display.',
  category: 'computer',
  safety: 'destructive',
  timeout: 30_000,
  parameters: {
    text: { type: 'string', required: true, description: 'Text to type.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = gateMutation('computer.type', ctx);
    if (gate) return gate;
    const text = params['text'];
    if (typeof text !== 'string' || text.length === 0) {
      return { success: false, output: 'computer.type: non-empty text is required.' };
    }
    // gui() carries text into the ScreenAction (Phase 0 fix in linux.ts).
    const res = await getDriver().gui({ action: 'type', text });
    return { success: res.success, output: res.error ?? `computer.type(${text.length} chars) OK` };
  },
};

const keyTool: ToolDefinition = {
  name: 'computer.key',
  description: 'Press a key or key chord (e.g. Return, Tab, ctrl+c, alt+F4) on the current display.',
  category: 'computer',
  safety: 'destructive',
  timeout: 15_000,
  parameters: {
    key: { type: 'string', required: true, description: 'Key name or chord, e.g. "Return" or "ctrl+c".' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = gateMutation('computer.key', ctx);
    if (gate) return gate;
    const key = params['key'];
    if (typeof key !== 'string' || key.trim().length === 0) {
      return { success: false, output: 'computer.key: a key name is required.' };
    }
    const res = await getDriver().gui({ action: 'key', key });
    return { success: res.success, output: res.error ?? `computer.key(${key}) OK` };
  },
};

const scrollTool: ToolDefinition = {
  name: 'computer.scroll',
  description: 'Scroll the current display up or down.',
  category: 'computer',
  safety: 'destructive',
  timeout: 15_000,
  parameters: {
    direction: { type: 'string', required: true, enum: ['up', 'down'], description: 'Scroll direction.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gate = gateMutation('computer.scroll', ctx);
    if (gate) return gate;
    const direction = params['direction'];
    if (direction !== 'up' && direction !== 'down') {
      return { success: false, output: 'computer.scroll: direction must be "up" or "down".' };
    }
    const res = await getDriver().gui({ action: 'scroll', direction });
    return { success: res.success, output: res.error ?? `computer.scroll(${direction}) OK` };
  },
};

const windowTool: ToolDefinition = {
  name: 'computer.window',
  description:
    'Manage windows and applications: list open windows, focus a window by name, or open an app/file/URL.',
  category: 'computer',
  safety: 'destructive',
  timeout: 15_000,
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'focus', 'open'], description: 'Window action.' },
    target: { type: 'string', required: false, description: 'Window name (focus) or app/path/URL (open).' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'];
    if (action !== 'list' && action !== 'focus' && action !== 'open') {
      return { success: false, output: 'computer.window: action must be list|focus|open.' };
    }
    // 'list' is read-only; focus/open mutate.
    if (action !== 'list') {
      const gate = gateMutation(`computer.window.${action}`, ctx);
      if (gate) return gate;
    } else if (killSwitchActive()) {
      return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };
    }
    const target = typeof params['target'] === 'string' ? (params['target'] as string) : undefined;
    if ((action === 'focus' || action === 'open') && !target) {
      return { success: false, output: `computer.window: "${action}" requires a target.` };
    }
    const res = await getDriver().desktop({ action, target });
    return {
      success: res.success,
      output: res.error ?? `computer.window.${action} OK`,
      data: res.data,
    };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const computerUseFamily: ToolDefinition[] = [
  screenshotTool,
  perceiveTool,
  clickTool,
  typeTool,
  keyTool,
  scrollTool,
  windowTool,
];

/**
 * Register the `computer.*` tool family. Auto-discovered by the builtin loader
 * (this file is `builtin/computer-use/index.ts`, matching the loader's
 * `/^register.+Tools$/` export convention).
 */
export function registerComputerUseTools(registry: ToolRegistry): void {
  for (const tool of computerUseFamily) registry.register(tool);
  log.info({ count: computerUseFamily.length }, 'computer.* tool family registered');
}
