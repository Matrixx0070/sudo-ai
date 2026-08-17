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

export class LinuxInputSink implements InputSink {
  constructor(private readonly display: string) {}

  click(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1']);
  }

  doubleClick(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '--repeat', '2', '1']);
  }

  move(x: number, y: number): Promise<{ success: boolean; error?: string }> {
    return xdo(this.display, ['mousemove', String(Math.round(x)), String(Math.round(y))]);
  }

  type(text: string): Promise<{ success: boolean; error?: string }> {
    return xdo(this.display, ['type', '--delay', '20', text]);
  }

  key(key: string): Promise<{ success: boolean; error?: string }> {
    // Allow only key-name-safe characters (letters, digits, +, -, _).
    const safe = key.replace(/[^a-zA-Z0-9+\-_]/g, '');
    if (!safe) return Promise.resolve({ success: false, error: 'invalid key' });
    return xdo(this.display, ['key', safe]);
  }

  scroll(direction: 'up' | 'down'): Promise<{ success: boolean; error?: string }> {
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
