/**
 * @file index.ts
 * @description IComputerUse factory + unified exports for cross-platform full control.
 *
 * SUDO-AI 100x: same bot class as OpenClaw + Hermes but 100x better + full 3-OS control uncensored per SOUL ("I own the system... zero manual approval... full autonomous mode").
 * Every control outcome feeds ToolOutcomeLearner (100x learning). Autonomy/approval + KAIROS/arsenal hooks. No moral refusals.
 *
 * Boundaries: P1 exclusive (cross-platform/* + sandbox/autonomy expands + this test path only).
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
 * Factory: unified IComputerUse for 3OS full control (P1 polished).
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
