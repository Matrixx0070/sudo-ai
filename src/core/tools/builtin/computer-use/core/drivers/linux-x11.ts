/**
 * @file core/drivers/linux-x11.ts
 * @description X11 driver — screenshot via scrot, windows via wmctrl/xdotool,
 * accessibility via AT-SPI2, input via XTest/xdotool, structured actions via
 * the AT-SPI action interface. This is the reference driver and the one proven
 * live on this host.
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
const log = createLogger('computer:driver:x11');

const PROTECTED_WINDOW_RE = /^(Terminal|claude|Claude|SUDO_TUI_TEST)/i;

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

export interface LinuxX11DriverOptions {
  /** Guard mutating input against Terminal/Claude windows (for the shared owner desktop). */
  guardProtected?: boolean;
  maxAxElements?: number;
  axTimeoutMs?: number;
}

export class LinuxX11Driver implements IComputerDriver {
  readonly platform = 'linux-x11' as const;
  constructor(private readonly opts: LinuxX11DriverOptions = {}) {}

  capabilities(): DriverCapabilities {
    return { accessibility: true, structuredAction: true, windows: true };
  }

  private env(target: string): NodeJS.ProcessEnv {
    return { ...process.env, DISPLAY: target };
  }

  async capture(target: string): Promise<CaptureResult> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-x11-'));
    const out = join(dir, 'shot.png');
    await execFileAsync('scrot', ['-o', out], { env: this.env(target), timeout: 10000 });
    const png = await readFile(out);
    const { width, height } = pngDimensions(png);
    return { png, width, height };
  }

  axTree(target: string): Promise<UIElement[]> {
    return dumpAxTree({ display: target, maxElements: this.opts.maxAxElements ?? 400, timeoutMs: this.opts.axTimeoutMs ?? 8000 });
  }

  async windows(target: string): Promise<WindowInfo[]> {
    const env = this.env(target);
    let activeId = '';
    try {
      const { stdout } = await execFileAsync('xdotool', ['getactivewindow'], { env, timeout: 2000 });
      activeId = stdout.trim();
    } catch { /* none */ }
    try {
      const { stdout } = await execFileAsync('wmctrl', ['-lG'], { env, timeout: 3000 });
      const wins: WindowInfo[] = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/);
        if (!m) continue;
        const idDec = String(parseInt(m[1], 16));
        wins.push({ id: m[1], x: +m[3], y: +m[4], w: +m[5], h: +m[6], title: m[7], active: activeId !== '' && (activeId === idDec || activeId === m[1]) });
      }
      return wins;
    } catch {
      return [];
    }
  }

  private async guardOk(target: string): Promise<{ success: boolean; error?: string } | null> {
    if (!this.opts.guardProtected) return null;
    try {
      const { stdout } = await execFileAsync('xdotool', ['getactivewindow', 'getwindowname'], { env: this.env(target), timeout: 2000 });
      if (PROTECTED_WINDOW_RE.test(stdout.trim())) return { success: false, error: 'blocked — protected window focused (MEMORY.md isolation rule)' };
    } catch { /* headless — allow */ }
    return null;
  }

  private xdo(target: string, args: string[]): Promise<{ success: boolean; error?: string }> {
    return execFileAsync('xdotool', args, { env: this.env(target), timeout: 10000 })
      .then(() => ({ success: true }))
      .catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
  }

  async inject(target: string, a: LowLevelAction): Promise<{ success: boolean; error?: string }> {
    const guard = await this.guardOk(target);
    if (guard) return guard;
    const X = (n?: number) => String(Math.round(n ?? 0));
    switch (a.kind) {
      case 'click':
        return this.xdo(target, ['mousemove', X(a.x), X(a.y), 'click', '1']);
      case 'double_click':
        return this.xdo(target, ['mousemove', X(a.x), X(a.y), 'click', '--repeat', '2', '1']);
      case 'move':
        return this.xdo(target, ['mousemove', X(a.x), X(a.y)]);
      case 'type':
        // `--` terminates option parsing so leading-dash text is literal.
        return this.xdo(target, ['type', '--delay', '20', '--', a.text ?? '']);
      case 'key': {
        const safe = (a.key ?? '').replace(/[^a-zA-Z0-9+\-_]/g, '');
        if (!safe || safe.startsWith('-')) return { success: false, error: 'invalid key' };
        return this.xdo(target, ['key', '--', safe]);
      }
      case 'scroll':
        return this.xdo(target, ['click', a.direction === 'up' ? '4' : '5']);
      case 'focus_window':
        return execFileAsync('wmctrl', ['-a', a.window ?? ''], { env: this.env(target), timeout: 4000 })
          .then(() => ({ success: true }))
          .catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
      default:
        return { success: false, error: `unsupported action ${(a as LowLevelAction).kind}` };
    }
  }

  structuredAction(target: string, match: StructuredMatch): Promise<boolean> {
    return invokeAxAction({ display: target, name: match.name, role: match.role, app: match.app });
  }
}
