/**
 * @file core/linux-input.ts
 * @description Display-aware Linux input sink (X11/XTest via xdotool).
 *
 * The executor drives one specific display at a time — including ephemeral Xvfb
 * displays that must NOT collide with the owner desktop — so input must carry an
 * explicit DISPLAY rather than relying on process.env. This is the canonical
 * display-parameterised input primitive for the Computer Use Backend; it uses
 * the same XTest/xdotool mechanism as the base driver, just addressable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../../../shared/logger.js';
import type { InputSink } from './executor.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:linux-input');

async function xdo(display: string, args: string[]): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync('xdotool', args, { env: { ...process.env, DISPLAY: display }, timeout: 10000 });
    return { success: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.debug({ display, args, error }, 'xdotool failed');
    return { success: false, error };
  }
}

/** Protected window titles that must never receive synthetic input (MEMORY.md isolation). */
const PROTECTED_WINDOW_RE = /^(Terminal|claude|Claude|SUDO_TUI_TEST)/i;

export class LinuxInputSink implements InputSink {
  /**
   * @param display  X display to address.
   * @param guardProtected  when true (use for the SHARED owner desktop), refuse
   *   mutating input while a Terminal/Claude window is focused. Leave false for
   *   ephemeral sessions the agent fully owns.
   */
  constructor(private readonly display: string, private readonly guardProtected = false) {}

  private async guardOk(): Promise<{ success: boolean; error?: string } | null> {
    if (!this.guardProtected) return null;
    try {
      const { stdout } = await execFileAsync('xdotool', ['getactivewindow', 'getwindowname'], {
        env: { ...process.env, DISPLAY: this.display },
        timeout: 2000,
      });
      if (PROTECTED_WINDOW_RE.test(stdout.trim())) {
        return { success: false, error: 'blocked — protected window focused (MEMORY.md isolation rule)' };
      }
    } catch {
      /* no active window / headless — allow */
    }
    return null;
  }

  async click(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    const g = await this.guardOk();
    if (g) return g;
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1']);
  }

  async doubleClick(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    const g = await this.guardOk();
    if (g) return g;
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', '2', '1']);
  }

  move(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y))]);
  }

  async type(text: string): Promise<{ success: boolean; error?: string }> {
    const g = await this.guardOk();
    if (g) return g;
    // `--` terminates xdotool option parsing so text beginning with a dash
    // (e.g. "--window") is treated as literal text, not a smuggled flag.
    return xdo(this.display, ['type', '--delay', '20', '--', text]);
  }

  async key(key: string): Promise<{ success: boolean; error?: string }> {
    const g = await this.guardOk();
    if (g) return g;
    // Allow only key-name-safe characters (letters, digits, +, -, _).
    const safe = key.replace(/[^a-zA-Z0-9+\-_]/g, '');
    if (!safe) return { success: false, error: 'invalid key' };
    // Reject a residual leading dash so a value like "--clearmodifiers" can't be
    // parsed as an option, and terminate options with `--` for defence in depth.
    if (safe.startsWith('-')) return { success: false, error: 'invalid key' };
    return xdo(this.display, ['key', '--', safe]);
  }

  async scroll(direction: 'up' | 'down'): Promise<{ success: boolean; error?: string }> {
    const g = await this.guardOk();
    if (g) return g;
    // xdotool: button 4 = scroll up, 5 = scroll down.
    return xdo(this.display, ['click', direction === 'up' ? '4' : '5']);
  }

  async focusWindow(title: string): Promise<{ success: boolean; error?: string }> {
    try {
      await execFileAsync('wmctrl', ['-a', title], { env: { ...process.env, DISPLAY: this.display }, timeout: 4000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
