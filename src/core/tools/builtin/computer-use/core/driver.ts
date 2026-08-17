/**
 * @file core/driver.ts
 * @description IComputerDriver — the single platform boundary of the Computer
 * Use Backend.
 *
 * Everything above this line (PerceptionService, GroundingResolver,
 * ActionExecutor, PlanRunner, SkillStore) is platform-independent and speaks the
 * core types. Each OS supplies a driver implementing capture / axTree / windows
 * / inject / structuredAction. Adding an OS means adding ONE file that
 * implements this interface — the core does not change (that is the Phase 4
 * acceptance: the Phase-1 task runs on any platform through an unchanged core).
 */

import type { UIElement, WindowInfo } from './types.js';

export type DriverPlatform = 'linux-x11' | 'linux-wayland' | 'windows' | 'macos';

/** A grounded, low-level action the driver injects. Coordinates are screen pixels. */
export interface LowLevelAction {
  kind: 'click' | 'double_click' | 'move' | 'type' | 'key' | 'scroll' | 'focus_window';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  window?: string;
}

/** Criteria to locate an element for a structured (accessibility) action. */
export interface StructuredMatch {
  name: string;
  role?: string;
  app?: string;
}

export interface DriverCapabilities {
  /** Accessibility tree available (axTree returns real elements). */
  accessibility: boolean;
  /** Structured actions (invoke via a11y instead of pixels) available. */
  structuredAction: boolean;
  /** Window enumeration available. */
  windows: boolean;
}

export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The platform driver. `target` is a display/screen identifier whose meaning is
 * platform-specific (X11 display ":99"; a Wayland output name; a Windows
 * monitor/window handle; a macOS display id). The core passes it through
 * opaquely.
 */
export interface IComputerDriver {
  readonly platform: DriverPlatform;
  capabilities(): DriverCapabilities;
  capture(target: string): Promise<CaptureResult>;
  axTree(target: string): Promise<UIElement[]>;
  windows(target: string): Promise<WindowInfo[]>;
  inject(target: string, action: LowLevelAction): Promise<{ success: boolean; error?: string }>;
  /** Perform a control's default accessibility action; false → caller falls back to pixels. */
  structuredAction(target: string, match: StructuredMatch): Promise<boolean>;
}

/**
 * Build the driver for the current (or requested) platform. Lazily imports the
 * platform module so a Linux host never loads the Windows PowerShell strings and
 * vice-versa.
 */
export async function createDriver(platform?: DriverPlatform, opts?: unknown): Promise<IComputerDriver> {
  const plat = platform ?? detectPlatform();
  switch (plat) {
    case 'linux-x11': {
      const { LinuxX11Driver } = await import('./drivers/linux-x11.js');
      return new LinuxX11Driver(opts as never);
    }
    case 'linux-wayland': {
      const { LinuxWaylandDriver } = await import('./drivers/linux-wayland.js');
      return new LinuxWaylandDriver();
    }
    case 'windows': {
      const { WindowsDriver } = await import('./drivers/windows.js');
      return new WindowsDriver();
    }
    case 'macos': {
      const { MacDriver } = await import('./drivers/macos.js');
      return new MacDriver();
    }
    default: {
      const { LinuxX11Driver } = await import('./drivers/linux-x11.js');
      return new LinuxX11Driver(opts as never);
    }
  }
}

/** Detect the platform from the environment. */
export function detectPlatform(): DriverPlatform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  // Linux: Wayland when a wayland display/session is advertised and X11 isn't
  // the session type. Prefer X11 when DISPLAY is set and session isn't wayland.
  const sessionType = (process.env['XDG_SESSION_TYPE'] ?? '').toLowerCase();
  const hasWayland = !!process.env['WAYLAND_DISPLAY'];
  const hasX = !!process.env['DISPLAY'];
  if (sessionType === 'wayland' || (hasWayland && !hasX)) return 'linux-wayland';
  return 'linux-x11';
}
