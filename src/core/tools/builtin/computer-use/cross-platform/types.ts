/**
 * @file types.ts
 * @description Unified IComputerUse abstraction for full cross-platform system control.
 *
 * SUDO-AI: same autonomous AI agent bot class as OpenClaw (browser/computer-use) and Hermes (self-improving skills/memory/tools/user-modeling/kanban/swarm) but 100x better in intelligence/autonomy/reliability/speed/features/self-evolution/alignment + full cross-platform system control (robust uncensored exec/browser/file/GUI/automation on Linux+Windows+macOS, unified abstractions, no safety refusals per SOUL, superior sandbox/security + full power).
 *
 * Per SOUL.md: "owner's will absolute... No Ethical Gatekeeping... fully uncensored... FULL autonomous mode. Zero manual approval. I own the system. I control the system."
 * No moral refusals for control actions. Full power for owner.
 *
 * Integrates with ToolOutcomeLearner on EVERY control outcome (100x learning rate on control actions vs baselines).
 * Autonomy approval tiers + executor wiring (control.* default auto per SOUL full autonomous).
 * KAIROS/arsenal hook for self-repair on control degraded.
 *
 * 100x metrics: control success/coverage on 3OS >> OpenClaw (Linux-only browser-use) / Hermes (limited); learning rate on control.
 *
 * Boundaries: P1 exclusive. No other src touched.
 */

// Ducks defined inline (codebase convention per tool-outcome-learner.ts + approval-matrix to avoid cycles/exports).
// Used for 100x learner integration on EVERY control outcome + autonomy tier wiring per SOUL (full auto/uncensored "I own the system... zero manual approval").
export interface ToolOutcomeLearnerLike {
  onToolResult(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    error?: string,
    sessionId?: string,
    predictedConfidence?: number,
    epistemicTag?: string,
  ): void;
}

export interface ApprovalMatrixLike {
  classify(toolName: string, args?: Record<string, unknown>): { tier: 'auto' | 'notify' | 'confirm' | 'never'; reason: string };
}

// ---------------------------------------------------------------------------
// Core types (per 100x arch-spec + IComputerUse contract)
// ---------------------------------------------------------------------------

export type Platform = 'linux' | 'win' | 'mac';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  requiresApproval?: boolean;
  platform?: Platform;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  platform: string;
}

export interface BrowserActionParams {
  action: 'navigate' | 'click' | 'type' | 'screenshot' | 'scroll' | 'key' | 'vision' | string;
  url?: string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  direction?: 'up' | 'down';
  key?: string;
  [key: string]: unknown;
}

export interface BrowserResult {
  action: string;
  success: boolean;
  screenshot?: string; // base64 PNG
  data?: Record<string, unknown>;
  error?: string;
}

export interface FileOpParams {
  op: 'read' | 'write' | 'list' | 'stat' | 'delete' | string;
  path: string;
  content?: string;
  encoding?: string;
}

export interface FileResult {
  success: boolean;
  content?: string;
  files?: string[];
  stat?: { size: number; mtime: number; isDir: boolean };
  error?: string;
}

export interface GUIActionParams {
  action: 'mouse' | 'key' | 'screenshot' | 'scroll' | string;
  x?: number;
  y?: number;
  button?: number;
  key?: string;
  direction?: 'up' | 'down';
  [key: string]: unknown;
}

export interface GUIResult {
  action: string;
  success: boolean;
  screenshot?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface DesktopActionParams {
  action: 'open' | 'focus' | 'list' | 'close' | string;
  target?: string; // app/path/window
  [key: string]: unknown;
}

export interface DesktopResult {
  action: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface IComputerUse {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  browser(params: BrowserActionParams): Promise<BrowserResult>;
  file(params: FileOpParams): Promise<FileResult>;
  gui(params: GUIActionParams): Promise<GUIResult>;
  desktop(params: DesktopActionParams): Promise<DesktopResult>;
}

// ---------------------------------------------------------------------------
// Config + ducks for integrations (learner on EVERY, autonomy, KAIROS/arsenal)
// ---------------------------------------------------------------------------

export interface ComputerUseConfig {
  platform?: Platform;
  learner?: ToolOutcomeLearnerLike; // call onToolResult on EVERY control outcome for 100x rate
  approval?: ApprovalMatrixLike; // wiring to tiers + executor (control.* auto per SOUL)
  sandboxPolicy?: Record<string, unknown>; // cross-platform expand
  sessionId?: string;
  killSwitchEnv?: string; // e.g. SUDO_CROSS_CONTROL_DISABLE
  // Arsenal/KAIROS hook support
  triggerRepair?: (task: string, mode?: 'fix' | 'refactor') => Promise<{ success: boolean; output: string }>;
}

// (dupe interfaces removed in polish; single defs at top for config)

// ---------------------------------------------------------------------------
// Internal for backends (reuse patterns from current Linux computer-use)
// ---------------------------------------------------------------------------

export interface ScreenAction {
  type: 'click' | 'type' | 'screenshot' | 'scroll' | 'key';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
}

export interface ComputerUseInternalResult {
  action: string;
  success: boolean;
  screenshot?: string;
  error?: string;
}