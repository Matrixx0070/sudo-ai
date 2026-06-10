/**
 * @file index.ts
 * @description IComputerUse factory + unified exports for cross-platform full control.
 *
 * Full-power, owner-controlled cross-platform system control. Linux is fully supported;
 * Windows and macOS backends are experimental. Every control outcome feeds ToolOutcomeLearner;
 * autonomy approval tiers + monitoring/self-repair hooks apply.
 */

import type {
  IComputerUse,
  ComputerUseConfig,
  Platform,
  ExecOptions,
  ExecResult,
  BrowserActionParams,
  BrowserResult,
  FileOpParams,
  FileResult,
  GUIActionParams,
  GUIResult,
  DesktopActionParams,
  DesktopResult,
} from './types.js';

import { LinuxComputerUse } from './linux.js';
import { WinComputerUse } from './win.js';
import { MacComputerUse } from './mac.js';

// Re-export all for consumers (autonomy, agent, etc.)
export type {
  IComputerUse,
  ComputerUseConfig,
  Platform,
  ExecOptions,
  ExecResult,
  BrowserActionParams,
  BrowserResult,
  FileOpParams,
  FileResult,
  GUIActionParams,
  GUIResult,
  DesktopActionParams,
  DesktopResult,
} from './types.js';

/**
 * Factory: unified IComputerUse for 3OS full control.
 * Linux: xdotool/scrot + bwrap/sandbox + fs.
 * Win/Mac: powershell/osascript + cross fs + shims.
 * Learner on EVERY; autonomy + KAIROS/arsenal; SOUL full power no refusals; 0 moral blocks.
 */
export function createComputerUse(config: ComputerUseConfig = {}): IComputerUse {
  const plat: Platform = config.platform || (process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux');

  if (plat === 'linux') return new LinuxComputerUse(config);
  if (plat === 'win') return new WinComputerUse(config);
  if (plat === 'mac') return new MacComputerUse(config);

  return new LinuxComputerUse(config); // fallback
}
