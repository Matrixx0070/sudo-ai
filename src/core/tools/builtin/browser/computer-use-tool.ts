/**
 * @file computer-use-tool.ts
 * @description ToolDefinition wrapper for low-level screen actions via xdotool/scrot.
 *
 * Exports:
 *   computerUseTool       — ToolDefinition for 'computer.use'
 *   registerComputerUseTools — register function called by registerBrowserTools
 *
 * Security:
 *   All mutating actions (click, type, scroll, key) are blocked if the active
 *   X window belongs to a Terminal or Claude Code session (MEMORY.md isolation rule).
 *   Screenshot actions are read-only and skip the guard.
 *   If no X display is available (headless CI), the guard fails open with a WARN log.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { executeComputerAction } from './computer-use.js';
import { requiresConfirmationDefault } from './autonomy.js';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';

const log = createLogger('tool:computer-use-tool');
const execAsync = promisify(exec);

/** Window name pattern that must be blocked — MEMORY.md isolation rule. */
const BLOCKED_WINDOW_RE = /^(Terminal|claude|Claude|SUDO_TUI_TEST)/i;

/** Actions that mutate the display and require the window guard. */
const GUARDED_ACTIONS = new Set(['click', 'type', 'scroll', 'key']);

// ---------------------------------------------------------------------------
// Window guard
// ---------------------------------------------------------------------------

/**
 * Check that the currently focused window is NOT a protected terminal/Claude window.
 *
 * @returns null when the action is safe to proceed, or a ToolResult-compatible
 *          object when blocked.
 * @throws Never — errors fail open (see spec line 124-126).
 */
async function runWindowGuard(
  action: string,
): Promise<{ blocked: false } | { blocked: true; output: string }> {
  // Ensure DISPLAY is set before any xdotool call.
  process.env['DISPLAY'] = process.env['DISPLAY'] ?? ':10.0';

  try {
    const { stdout } = await execAsync('xdotool getactivewindow getwindowname');
    const winName = stdout.trim();

    if (BLOCKED_WINDOW_RE.test(winName)) {
      log.warn({ winName, action }, 'computer.use: blocked — protected window detected');
      return {
        blocked: true,
        output:
          'computer.use: blocked — xdotool actions are not permitted in Terminal or Claude Code windows (MEMORY.md isolation rule)',
      };
    }

    return { blocked: false };
  } catch (err) {
    // No active window or DISPLAY unavailable — allow through in headless CI.
    log.warn(
      { action, err: err instanceof Error ? err.message : String(err) },
      'computer.use: window guard could not determine active window (headless/no-display) — allowing action',
    );
    return { blocked: false };
  }
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const computerUseTool: ToolDefinition = {
  name: 'computer.use',
  description:
    'Execute a low-level screen action (click, type, screenshot, scroll, key) using xdotool and scrot. Requires DISPLAY env to be set.',
  category: 'browser',
  // Confirm unless unattended mode (SUDO_BROWSER_UNATTENDED=1) is enabled; safety
  // stays 'destructive' so the ConfidenceGate still evaluates it when unattended.
  requiresConfirmation: requiresConfirmationDefault(),
  safety: 'destructive',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['click', 'type', 'screenshot', 'scroll', 'key'],
      description: 'Action to perform on the screen.',
    },
    x: {
      type: 'number',
      required: false,
      description: 'X coordinate in pixels. Required for click.',
    },
    y: {
      type: 'number',
      required: false,
      description: 'Y coordinate in pixels. Required for click.',
    },
    text: {
      type: 'string',
      required: false,
      description: 'Text to type. Required for type action.',
    },
    key: {
      type: 'string',
      required: false,
      description: 'Key name (e.g. Return, ctrl+c). Required for key action.',
    },
    direction: {
      type: 'string',
      required: false,
      enum: ['up', 'down'],
      description: 'Scroll direction. Required for scroll action.',
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext) {
    const action = params['action'];

    if (typeof action !== 'string') {
      return { success: false, output: 'computer.use: action parameter is required and must be a string.' };
    }

    // Apply window guard for all mutating actions.
    if (GUARDED_ACTIONS.has(action)) {
      const guardResult = await runWindowGuard(action);
      if (guardResult.blocked) {
        return { success: false, output: guardResult.output };
      }
    }

    // Map params to ScreenAction and delegate to the underlying computer-use module.
    const screenAction = {
      type: action as 'click' | 'type' | 'screenshot' | 'scroll' | 'key',
      x: typeof params['x'] === 'number' ? params['x'] : undefined,
      y: typeof params['y'] === 'number' ? params['y'] : undefined,
      text: typeof params['text'] === 'string' ? params['text'] : undefined,
      key: typeof params['key'] === 'string' ? params['key'] : undefined,
      direction:
        params['direction'] === 'up' || params['direction'] === 'down'
          ? (params['direction'] as 'up' | 'down')
          : undefined,
    };

    const result = await executeComputerAction(screenAction);

    // Screenshot: return base64 PNG in data field.
    if (action === 'screenshot') {
      return {
        success: result.success,
        output: result.success ? 'screenshot captured' : (result.error ?? 'screenshot failed'),
        data: result.success ? { screenshot: result.screenshot ?? '' } : undefined,
      };
    }

    // All other actions.
    return {
      success: result.success,
      output: result.error ?? `computer.use: ${result.action} OK`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register the computer.use tool with the provided registry.
 * Called once during application startup from registerBrowserTools.
 */
export function registerComputerUseTools(registry: ToolRegistry): void {
  registry.register(computerUseTool);
}
