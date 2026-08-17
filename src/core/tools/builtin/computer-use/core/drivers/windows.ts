/**
 * @file core/drivers/windows.ts
 * @description Windows driver (PowerShell host bridge).
 *
 * Mechanisms (the research's Windows practitioner layer):
 *   - capture: System.Drawing Graphics.CopyFromScreen → PNG.
 *   - input:   SendInput via user32 P/Invoke (SetCursorPos + mouse_event; keybd
 *              for keys; per-char for text).
 *   - windows: EnumWindows + GetWindowText/GetWindowRect via user32.
 *   - a11y:    UI Automation (UIAutomationClient) — element name + bounding rect;
 *              structuredAction uses the InvokePattern (UIA-first, click fallback).
 *
 * Each capability is a short inlined PowerShell program invoked via
 * `powershell -NoProfile -Command`. NOT live-proven on this Linux host — written
 * to the documented Win32/UIA APIs; the factory only selects it on win32.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../../../shared/logger.js';
import type { UIElement, WindowInfo } from '../types.js';
import type { CaptureResult, DriverCapabilities, IComputerDriver, LowLevelAction, StructuredMatch } from '../driver.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:driver:windows');

function ps(script: string, timeout = 15000): Promise<string> {
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout);
}

const CAPTURE_PS = (outPath: string) => `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($b.Width)x$($b.Height)"
`;

const WINDOWS_PS = `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class W{
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
 public struct RECT{public int Left,Top,Right,Bottom;}
}
"@
$fg=[W]::GetForegroundWindow()
[W]::EnumWindows({param($h,$p) if([W]::IsWindowVisible($h)){$sb=New-Object System.Text.StringBuilder 512;[void][W]::GetWindowText($h,$sb,512);$t=$sb.ToString();if($t){$r=New-Object W+RECT;[void][W]::GetWindowRect($h,[ref]$r);$a=($h -eq $fg);Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $t,$r.Left,$r.Top,($r.Right-$r.Left),($r.Bottom-$r.Top),$a)}} return $true},[IntPtr]::Zero) | Out-Null
`;

const INJECT_PS = (a: LowLevelAction) => {
  const x = Math.round(a.x ?? 0);
  const y = Math.round(a.y ?? 0);
  const header = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class I{
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
 public const uint LD=0x0002,LU=0x0004,WHEEL=0x0800;
}
"@
Add-Type -AssemblyName System.Windows.Forms
`;
  switch (a.kind) {
    case 'move':
      return header + `[I]::SetCursorPos(${x},${y})`;
    case 'click':
      return header + `[I]::SetCursorPos(${x},${y});[I]::mouse_event([I]::LD,0,0,0,[IntPtr]::Zero);[I]::mouse_event([I]::LU,0,0,0,[IntPtr]::Zero)`;
    case 'double_click':
      return header + `[I]::SetCursorPos(${x},${y});1..2|%{[I]::mouse_event([I]::LD,0,0,0,[IntPtr]::Zero);[I]::mouse_event([I]::LU,0,0,0,[IntPtr]::Zero)}`;
    case 'scroll':
      return header + `[I]::mouse_event([I]::WHEEL,0,0,${a.direction === 'up' ? 120 : -120},[IntPtr]::Zero)`;
    case 'type':
      // SendKeys — escape special chars; text passed base64 to avoid quoting issues.
      return header + `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(a.text ?? '').toString('base64')}'));[System.Windows.Forms.SendKeys]::SendWait([System.Windows.Forms.SendKeys]::Escape($t))`;
    case 'key':
      return header + `[System.Windows.Forms.SendKeys]::SendWait('${winKey(a.key ?? '')}')`;
    case 'focus_window':
      return header + `$w=Get-Process|?{$_.MainWindowTitle -like '*${(a.window ?? '').replace(/'/g, '')}*'}|Select-Object -First 1;if($w){(New-Object -ComObject WScript.Shell).AppActivate($w.Id)}`;
    default:
      return `Write-Error "unsupported"`;
  }
};

/** Map our key names to SendKeys syntax (best-effort). */
function winKey(key: string): string {
  const map: Record<string, string> = { Return: '{ENTER}', Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}', Backspace: '{BACKSPACE}', Delete: '{DEL}', Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}' };
  if (map[key]) return map[key];
  // ctrl+c → ^c, alt+F4 → %{F4}
  return key
    .split('+')
    .map((k) => (k === 'ctrl' ? '^' : k === 'alt' ? '%' : k === 'shift' ? '+' : map[k] ?? k))
    .join('');
}

const UIA_TREE_PS = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$cond=[System.Windows.Automation.Condition]::TrueCondition
$els=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)
$i=0
foreach($e in $els){ if($i -ge 400){break}; try{ $r=$e.Current.BoundingRectangle; $n=$e.Current.Name; $c=$e.Current.ControlType.ProgrammaticName -replace 'ControlType\\.',''; if($r.Width -gt 0 -and $r.Height -gt 0){ Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $i,$c,$n,[int]$r.X,[int]$r.Y,("{0}|{1}" -f [int]$r.Width,[int]$r.Height)); $i++ } }catch{} }
`;

const STRUCTURED_PS = (m: StructuredMatch) => `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${m.name.replace(/'/g, '')}')
$e=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond)
if($e){ try{ $p=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); Write-Output 'OK' }catch{ try{ $e.SetFocus(); Write-Output 'OK' }catch{ Write-Output 'FAIL' } } } else { Write-Output 'FAIL' }
`;

export class WindowsDriver implements IComputerDriver {
  readonly platform = 'windows' as const;

  capabilities(): DriverCapabilities {
    return { accessibility: true, structuredAction: true, windows: true };
  }

  async capture(_target: string): Promise<CaptureResult> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-win-'));
    const out = join(dir, 'shot.png');
    const dims = (await ps(CAPTURE_PS(out))).trim();
    const png = await readFile(out);
    const [w, h] = dims.split('x').map((n) => parseInt(n, 10) || 0);
    return { png, width: w, height: h };
  }

  async axTree(_target: string): Promise<UIElement[]> {
    try {
      const out = await ps(UIA_TREE_PS, 20000);
      const els: UIElement[] = [];
      for (const line of out.split('\n')) {
        const p = line.trim().split('|');
        if (p.length < 7) continue;
        els.push({ i: +p[0], role: p[1].toLowerCase(), name: p[2], states: [], x: +p[3], y: +p[4], w: +p[5], h: +p[6], app: '' });
      }
      return els;
    } catch (e) {
      log.debug({ err: String(e) }, 'UIA tree failed');
      return [];
    }
  }

  async windows(_target: string): Promise<WindowInfo[]> {
    try {
      const out = await ps(WINDOWS_PS);
      const wins: WindowInfo[] = [];
      for (const line of out.split('\n')) {
        const p = line.trim().split('|');
        if (p.length < 6) continue;
        wins.push({ title: p[0], x: +p[1], y: +p[2], w: +p[3], h: +p[4], active: p[5] === 'True' });
      }
      return wins;
    } catch {
      return [];
    }
  }

  async inject(_target: string, a: LowLevelAction): Promise<{ success: boolean; error?: string }> {
    try {
      await ps(INJECT_PS(a));
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async structuredAction(_target: string, match: StructuredMatch): Promise<boolean> {
    try {
      const out = await ps(STRUCTURED_PS(match));
      return out.trim().startsWith('OK');
    } catch {
      return false;
    }
  }
}
