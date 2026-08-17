/**
 * @file core/drivers/linux-wayland.ts
 * @description Wayland driver.
 *
 * Wayland is compositor-mediated: there is no global screen scraping or input
 * injection, so mechanisms are negotiated per capability:
 *   - capture: `grim` (wlroots) → `gnome-screenshot` → the Screenshot portal.
 *   - input:   `ydotool` (kernel /dev/uinput via ydotoold) — compositor-agnostic.
 *              (The RemoteDesktop portal + libei is the sanctioned path but needs
 *              an interactive grant; ydotool is the headless fallback.)
 *   - windows: `wlrctl toplevel list` (wlroots) — best-effort; often empty.
 *   - a11y:    AT-SPI2 is display-agnostic and works identically to X11, so the
 *              accessibility tree AND structured actions are fully real here.
 *
 * NOT live-proven on this X11 host — implemented to the documented mechanisms
 * with capability probing so it degrades honestly on a compositor that lacks a
 * given tool.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../../../shared/logger.js';
import type { UIElement, WindowInfo } from '../types.js';
import type { CaptureResult, DriverCapabilities, IComputerDriver, LowLevelAction, StructuredMatch } from '../driver.js';
import { dumpAxTree, invokeAxAction } from '../atspi.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:driver:wayland');

async function has(bin: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${bin}`], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  return { width: 0, height: 0 };
}

export class LinuxWaylandDriver implements IComputerDriver {
  readonly platform = 'linux-wayland' as const;
  private probed?: DriverCapabilities;

  capabilities(): DriverCapabilities {
    // Accessibility is always attempted (AT-SPI); input/windows depend on tools.
    return this.probed ?? { accessibility: true, structuredAction: true, windows: true };
  }

  async probe(): Promise<DriverCapabilities> {
    const [ydotool, grim, gnome, wlrctl] = await Promise.all([has('ydotool'), has('grim'), has('gnome-screenshot'), has('wlrctl')]);
    this.probed = {
      accessibility: true,
      structuredAction: true,
      windows: wlrctl,
    };
    log.info({ ydotool, grim, gnome, wlrctl }, 'wayland capabilities probed');
    return this.probed;
  }

  async capture(_target: string): Promise<CaptureResult> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-wl-'));
    const out = join(dir, 'shot.png');
    if (await has('grim')) {
      await execFileAsync('grim', [out], { timeout: 10000 });
    } else if (await has('gnome-screenshot')) {
      await execFileAsync('gnome-screenshot', ['-f', out], { timeout: 10000 });
    } else {
      throw new Error('no Wayland screenshot tool (install grim or gnome-screenshot, or grant the Screenshot portal)');
    }
    const png = await readFile(out);
    const { width, height } = pngDimensions(png);
    return { png, width, height };
  }

  // AT-SPI is display-agnostic — target is ignored, the session bus is used.
  axTree(_target: string): Promise<UIElement[]> {
    return dumpAxTree({ display: process.env['DISPLAY'] ?? ':0', maxElements: 400, timeoutMs: 8000 });
  }

  async windows(_target: string): Promise<WindowInfo[]> {
    if (!(await has('wlrctl'))) return [];
    try {
      const { stdout } = await execFileAsync('wlrctl', ['toplevel', 'list'], { timeout: 3000 });
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((title) => ({ title }));
    } catch {
      return [];
    }
  }

  async inject(_target: string, a: LowLevelAction): Promise<{ success: boolean; error?: string }> {
    if (!(await has('ydotool'))) {
      return { success: false, error: 'ydotool not available (Wayland input needs ydotool + ydotoold, or the RemoteDesktop portal)' };
    }
    const run = (args: string[]) =>
      execFileAsync('ydotool', args, { timeout: 8000 })
        .then(() => ({ success: true }))
        .catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
    const N = (n?: number) => String(Math.round(n ?? 0));
    switch (a.kind) {
      case 'move':
        return run(['mousemove', '--absolute', '-x', N(a.x), '-y', N(a.y)]);
      case 'click':
        await run(['mousemove', '--absolute', '-x', N(a.x), '-y', N(a.y)]);
        return run(['click', '0xC0']); // 0xC0 = left down+up
      case 'double_click':
        await run(['mousemove', '--absolute', '-x', N(a.x), '-y', N(a.y)]);
        await run(['click', '0xC0']);
        return run(['click', '0xC0']);
      case 'type':
        return run(['type', '--', a.text ?? '']);
      case 'key': {
        const safe = (a.key ?? '').replace(/[^a-zA-Z0-9+\-_]/g, '');
        if (!safe || safe.startsWith('-')) return { success: false, error: 'invalid key' };
        return run(['key', safe]);
      }
      case 'scroll':
        return run(['mousemove', '--wheel', '-y', a.direction === 'up' ? '-15' : '15']);
      case 'focus_window':
        return { success: false, error: 'focus_window not supported on Wayland (no global window control)' };
      default:
        return { success: false, error: `unsupported action ${(a as LowLevelAction).kind}` };
    }
  }

  structuredAction(_target: string, match: StructuredMatch): Promise<boolean> {
    return invokeAxAction({ display: process.env['DISPLAY'] ?? ':0', name: match.name, role: match.role, app: match.app });
  }
}
