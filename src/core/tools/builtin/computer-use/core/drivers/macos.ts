/**
 * @file core/drivers/macos.ts
 * @description macOS driver (skeleton — completed in Phase 5).
 *
 * Mechanisms: `screencapture` for pixels; `osascript` System Events for keystroke
 * and window queries; the AXAPI (AXUIElement) via a helper for the accessibility
 * tree and structured actions (AXPress). TCC grants (Accessibility + Screen
 * Recording) attach to the responsible process. NOT live-proven on this host.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIElement, WindowInfo } from '../types.js';
import type { CaptureResult, DriverCapabilities, IComputerDriver, LowLevelAction, StructuredMatch } from '../driver.js';

const execFileAsync = promisify(execFile);

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  return { width: 0, height: 0 };
}

/** Map key names to AppleScript key codes / keystroke syntax (best-effort). */
function osaKey(key: string): string {
  const codes: Record<string, number> = { Return: 36, Enter: 36, Tab: 48, Escape: 53, Backspace: 51, Delete: 117, Up: 126, Down: 125, Left: 123, Right: 124 };
  if (codes[key] !== undefined) return `key code ${codes[key]}`;
  const mods = key.split('+');
  const base = mods.pop() ?? '';
  const using = mods
    .map((m) => (m === 'ctrl' ? 'control down' : m === 'alt' ? 'option down' : m === 'cmd' ? 'command down' : m === 'shift' ? 'shift down' : ''))
    .filter(Boolean)
    .join(', ');
  const esc = base.replace(/"/g, '\\"');
  return using ? `keystroke "${esc}" using {${using}}` : `keystroke "${esc}"`;
}

export class MacDriver implements IComputerDriver {
  readonly platform = 'macos' as const;

  capabilities(): DriverCapabilities {
    return { accessibility: true, structuredAction: true, windows: true };
  }

  async capture(_target: string): Promise<CaptureResult> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-mac-'));
    const out = join(dir, 'shot.png');
    await execFileAsync('screencapture', ['-x', out], { timeout: 10000 });
    const png = await readFile(out);
    const { width, height } = pngDimensions(png);
    return { png, width, height };
  }

  // Full AXAPI tree extraction lands in Phase 5 (needs a helper binary).
  async axTree(_target: string): Promise<UIElement[]> {
    return [];
  }

  async windows(_target: string): Promise<WindowInfo[]> {
    const script = 'tell application "System Events" to get {name, position, size} of every window of (every process whose visible is true)';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      // Best-effort parse; Phase 5 hardens this.
      return stdout.trim() ? [{ title: stdout.trim().slice(0, 120) }] : [];
    } catch {
      return [];
    }
  }

  async inject(_target: string, a: LowLevelAction): Promise<{ success: boolean; error?: string }> {
    const osa = (script: string) =>
      execFileAsync('osascript', ['-e', script], { timeout: 6000 })
        .then(() => ({ success: true }))
        .catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
    const x = Math.round(a.x ?? 0);
    const y = Math.round(a.y ?? 0);
    switch (a.kind) {
      case 'type':
        return osa(`tell application "System Events" to keystroke "${(a.text ?? '').replace(/"/g, '\\"')}"`);
      case 'key':
        return osa(`tell application "System Events" to ${osaKey(a.key ?? '')}`);
      case 'click':
      case 'double_click':
      case 'move':
      case 'scroll':
        // Pointer control needs `cliclick` or a CGEvent helper (Phase 5).
        return { success: false, error: `pointer action ${a.kind} at ${x},${y} needs the Phase 5 CGEvent helper` };
      case 'focus_window':
        return osa(`tell application "${(a.window ?? '').replace(/"/g, '\\"')}" to activate`);
      default:
        return { success: false, error: `unsupported action ${(a as LowLevelAction).kind}` };
    }
  }

  async structuredAction(_target: string, _match: StructuredMatch): Promise<boolean> {
    // AXUIElementPerformAction(kAXPressAction) via a helper — Phase 5.
    return false;
  }
}
