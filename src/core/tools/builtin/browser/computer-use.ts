/**
 * Upgrade 57: Computer Use Agent
 *
 * Execute low-level screen interactions via xdotool and capture screenshots
 * via scrot.  Requires both utilities to be installed on the host system.
 *
 * This module provides pure utility functions; it does not self-register as a
 * ToolDefinition.  Higher-level tools or the agent loop import these directly.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:computer-use');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScreenAction {
  type: 'click' | 'type' | 'screenshot' | 'scroll' | 'key';
  /** X coordinate — required for click */
  x?: number;
  /** Y coordinate — required for click */
  y?: number;
  /** Text to type — required for type */
  text?: string;
  /** Key name (e.g. "Return", "ctrl+c") — required for key */
  key?: string;
  /** Scroll direction — required for scroll */
  direction?: 'up' | 'down';
}

export interface ComputerUseResult {
  action: string;
  success: boolean;
  /** Base64-encoded PNG — only present for screenshot actions */
  screenshot?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCREENSHOT_PATH = '/tmp/sudo-screenshot.png';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateCoords(x: unknown, y: unknown, label: string): string | null {
  if (typeof x !== 'number' || typeof y !== 'number') {
    return `${label} requires numeric x and y coordinates`;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return `${label} coordinates must be finite numbers`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single computer-use action and return the result.
 *
 * All xdotool/scrot errors are caught and surfaced via the result object
 * rather than thrown so callers can handle failures gracefully.
 */
export async function executeComputerAction(action: ScreenAction): Promise<ComputerUseResult> {
  if (!action?.type) {
    return { action: 'unknown', success: false, error: 'Action type is required' };
  }

  log.debug({ type: action.type }, 'Executing computer action');

  try {
    switch (action.type) {
      case 'click': {
        const err = validateCoords(action.x, action.y, 'click');
        if (err) return { action: 'click', success: false, error: err };

        await execFileAsync('xdotool', ['mousemove', String(action.x), String(action.y), 'click', '1']);
        log.info({ x: action.x, y: action.y }, 'Clicked');
        return { action: `click(${action.x},${action.y})`, success: true };
      }

      case 'type': {
        if (!action.text) {
          return { action: 'type', success: false, error: 'text is required for type action' };
        }
        await execFileAsync('xdotool', ['type', '--delay', '50', action.text]);
        log.info({ chars: action.text.length }, 'Typed text');
        return { action: `type(${action.text.substring(0, 30)}...)`, success: true };
      }

      case 'screenshot': {
        await execFileAsync('scrot', [SCREENSHOT_PATH]);
        const buf = await readFile(SCREENSHOT_PATH);
        log.info({ bytes: buf.length }, 'Screenshot captured');
        return { action: 'screenshot', success: true, screenshot: buf.toString('base64') };
      }

      case 'scroll': {
        if (!action.direction) {
          return { action: 'scroll', success: false, error: 'direction (up|down) is required for scroll' };
        }
        // xdotool button 4 = scroll up, 5 = scroll down
        const btn = action.direction === 'up' ? 4 : 5;
        await execFileAsync('xdotool', ['click', String(btn)]);
        log.info({ direction: action.direction }, 'Scrolled');
        return { action: `scroll(${action.direction})`, success: true };
      }

      case 'key': {
        if (!action.key?.trim()) {
          return { action: 'key', success: false, error: 'key name is required for key action' };
        }
        // Sanitise: allow only alphanumeric, +, -, _
        const safeKey = action.key.replace(/[^a-zA-Z0-9+\-_]/g, '');
        if (!safeKey) return { action: 'key', success: false, error: 'key name contained invalid characters' };

        await execFileAsync('xdotool', ['key', safeKey]);
        log.info({ key: safeKey }, 'Key pressed');
        return { action: `key(${safeKey})`, success: true };
      }

      default:
        return { action: (action as ScreenAction).type, success: false, error: 'Unknown action type' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ type: action.type, error: message }, 'Computer action failed');
    return { action: action.type, success: false, error: message };
  }
}
