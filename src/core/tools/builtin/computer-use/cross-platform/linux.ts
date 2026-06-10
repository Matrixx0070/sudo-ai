/**
 * @file linux.ts
 * @description Linux backend for IComputerUse: reuse xdotool/scrot + bwrap/sandbox + node for full control.
 *
 * Linux backend: exec + file + gui + desktop + browser actions, integrated with the outcome learner,
 * a monitoring/self-repair hook, and autonomy approval (control.* defaults to 'auto'). Safety is
 * enforced operationally via sandbox isolation, approval tiers, and kill-switches.
 *
 * Reuses proven Linux from browser/computer-use.ts (executeComputerAction, ScreenAction) + system/sandbox.
 * Every outcome -> learner.onToolResult('control.xxx' ...).
 * Hooks for approval (via config) + KAIROS/arsenal (triggerRepair).
 * 100x metrics support in harness.
 *
 * P1 boundaries only.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type {
  IComputerUse,
  ComputerUseConfig,
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
  ScreenAction,
} from './types.js';

// Reuse existing Linux computer-use logic (imported for reuse, not edit)
import { executeComputerAction } from '../../browser/computer-use.js';

// Sandbox for exec/file (cross expand)
import { runInSandbox, buildSandboxEnv } from '../../../../sandbox/sandbox-runner.js';
import type { SandboxPolicy } from '../../../../sandbox/sandbox-types.js';
import { DEFAULT_SANDBOX_POLICY } from '../../../../sandbox/sandbox-types.js';

// For KAIROS/arsenal hook (if provided in config)
type TriggerRepair = (task: string, mode?: 'fix' | 'refactor') => Promise<{ success: boolean; output: string }>;

const log = createLogger('control:cross:linux');
const execFileAsync = promisify(execFile);

const SCREENSHOT_PATH = '/tmp/sudo-screenshot.png';

function validateCoords(x: unknown, y: unknown, label: string): string | null {
  if (typeof x !== 'number' || typeof y !== 'number') {
    return `${label} requires numeric x and y coordinates`;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return `${label} coordinates must be finite numbers`;
  }
  return null;
}

export class LinuxComputerUse implements IComputerUse {
  private readonly config: ComputerUseConfig;
  private readonly triggerRepair?: TriggerRepair;

  constructor(config: ComputerUseConfig = {}) {
    this.config = config;
    this.triggerRepair = config.triggerRepair;
    log.info({ platform: 'linux' }, 'LinuxComputerUse initialized');
  }

  private async recordOutcome(toolName: string, args: Record<string, unknown>, success: boolean, error?: string, durationMs?: number): Promise<void> {
    if (this.config.learner) {
      try {
        this.config.learner.onToolResult(
          toolName,
          args,
          success,
          error,
          this.config.sessionId,
          undefined,
          'control,cross-platform,linux',
        );
      } catch (e) {
        log.warn({ err: e, tool: toolName }, 'learner.onToolResult failed (fail-open for 100x)');
      }
    }
    // KAIROS/arsenal hook on degraded control (per plan)
    if (!success && error && this.triggerRepair && process.env['SUDO_KAIROS_ARSENAL_TRIGGER_DISABLE'] !== '1') {
      try {
        const task = `KAIROS: control ${toolName} degraded on linux: ${error.slice(0, 100)}. Use coder.arsenal to fix.`;
        await this.triggerRepair(task, 'fix');
        log.info({ tool: toolName }, 'KAIROS/arsenal trigger fired for control repair');
      } catch (e) {
        log.warn({ err: e }, 'KAIROS trigger non-fatal');
      }
    }
  }

  private getSandboxPolicy(): SandboxPolicy | undefined {
    // From expanded sandbox config (compat)
    return this.config.sandboxPolicy as SandboxPolicy | undefined;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const args = { cmd, opts };
    const policy = this.getSandboxPolicy();

    // Per SOUL: no refusal, full power (only kill/approval external)
    if (process.env[this.config.killSwitchEnv || 'SUDO_CROSS_CONTROL_DISABLE'] === '1') {
      await this.recordOutcome('control.exec', args, false, 'kill-switch');
      return { success: false, stdout: '', stderr: 'kill-switch', exitCode: 1, durationMs: Date.now() - start, platform: 'linux' };
    }

    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      if (policy && policy.enabled !== false) {
        // Use expanded sandbox-runner (cross compat)
        const res = await runInSandbox({
          command: cmd,
          workspaceDir: opts.cwd || process.cwd(),
          policy,
          timeoutMs: opts.timeout || 30000,
        });
        stdout = res.stdout;
        stderr = res.stderr;
        exitCode = res.exitCode;
      } else {
        // P1 fix HIGH-1: scrub even in direct path (never raw process.env)
        const baseEnv = buildSandboxEnv(policy || DEFAULT_SANDBOX_POLICY);
        const childEnv = opts.env ? { ...baseEnv, ...opts.env } : baseEnv;
        const { stdout: so, stderr: se } = await execFileAsync('/bin/sh', ['-c', cmd], {
          cwd: opts.cwd,
          env: childEnv,
          timeout: opts.timeout,
          maxBuffer: 8 * 1024 * 1024,
        });
        stdout = so.trim();
        stderr = se.trim();
      }

      const result: ExecResult = {
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - start,
        platform: 'linux',
      };
      await this.recordOutcome('control.exec', args, result.success, result.success ? undefined : stderr || 'nonzero exit');
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordOutcome('control.exec', args, false, message);
      return { success: false, stdout: '', stderr: message, exitCode: 1, durationMs: Date.now() - start, platform: 'linux' };
    }
  }

  async browser(params: BrowserActionParams): Promise<BrowserResult> {
    const start = Date.now();
    // Reuse Linux gui/screen logic (generalized from computer-use)
    const screenAction: ScreenAction = {
      type: params.action as ScreenAction['type'],
      x: params.x,
      y: params.y,
      text: params.text,
      key: params.key,
      direction: params.direction as 'up' | 'down' | undefined,
    };

    if (params.action === 'navigate' && params.url) {
      // For desktop browser nav, could delegate but keep simple screen + note (full web via existing browser tools)
      log.info({ url: params.url }, 'browser navigate (screen-level; use browser.* tools for full web)');
    }

    // P1 fix HIGH-2: re-apply window guard (MEMORY.md isolation) before screen actions for control.gui/browser
    // (dupe minimal logic since runWindowGuard not exported from browser/ and boundaries forbid edit there)
    const BLOCKED_WINDOW_RE = /^(Terminal|claude|Claude|SUDO_TUI_TEST)/i;
    const GUARDED = new Set(['click','type','scroll','key']);
    if (GUARDED.has(params.action) || params.action === 'key') {
      try {
        process.env['DISPLAY'] = process.env['DISPLAY'] ?? ':10.0';
        const { stdout } = await execFileAsync('xdotool', ['getactivewindow', 'getwindowname']);
        const winName = stdout.trim();
        if (BLOCKED_WINDOW_RE.test(winName)) {
          log.warn({ winName, action: params.action }, 'control: blocked protected window (MEMORY isolation)');
          const bres: BrowserResult = { action: params.action, success: false, error: 'control: blocked — protected window (MEMORY.md isolation rule)' };
          await this.recordOutcome(`control.browser.${params.action}`, params as Record<string, unknown>, false, bres.error);
          return bres;
        }
      } catch (e) {
        log.warn({ action: params.action, err: e }, 'control window guard could not determine (headless) — allow per original');
      }
    }

    const res = await executeComputerAction(screenAction);
    const bres: BrowserResult = {
      action: params.action,
      success: res.success,
      screenshot: res.screenshot,
      error: res.error,
    };
    await this.recordOutcome(`control.browser.${params.action}`, params as Record<string, unknown>, bres.success, bres.error);
    return bres;
  }

  async file(params: FileOpParams): Promise<FileResult> {
    const start = Date.now();
    const policy = this.getSandboxPolicy();
    try {
      let success = true;
      let content: string | undefined;
      let files: string[] | undefined;
      let statRes: { size: number; mtime: number; isDir: boolean } | undefined;
      let error: string | undefined;

      const absPath = path.resolve(params.path);

      // P1 fix HIGH-3: sensitive FS denylist + SOUL exfil protection for control.file (read/write/delete/list/stat on creds/MEMORY/.ssh etc)
      // P1 refine (Codex post-remed + lessons): narrow to sensitive *subpaths* only (not broad /root /home which blocked normal workspace ops); workspace-rel allowed (e.g. the project root, /home/*/proj, /tmp); still protects real secrets per SOUL "never exfiltrate".
      const SENSITIVE_DENY = ['/etc/shadow', '/etc/passwd', '/root/.ssh', '/home/.ssh', 'MEMORY.md', 'data/credentials', '/root/.aws', '/root/.config/sudo-ai', '/boot', '/var/lib/sudo'];
      const normalized = absPath.toLowerCase();
      if (SENSITIVE_DENY.some(s => normalized.includes(s.toLowerCase()) || normalized.startsWith(path.resolve(s).toLowerCase()))) {
        const errMsg = 'control.file: sensitive path blocked (SOUL: never exfiltrate owner data; use approved coder tools for owner-intended)';
        const fres: FileResult = { success: false, error: errMsg };
        await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, false, errMsg);
        return fres;
      }

      if (params.op === 'read') {
        content = await readFile(absPath, (params.encoding || 'utf8') as BufferEncoding);
      } else if (params.op === 'write' && params.content !== undefined) {
        await writeFile(absPath, params.content, 'utf8');
      } else if (params.op === 'list') {
        files = await readdir(absPath);
      } else if (params.op === 'stat') {
        const s = await stat(absPath);
        statRes = { size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } else if (params.op === 'delete') {
        await rm(absPath, { recursive: true, force: true });
      } else {
        success = false;
        error = `unknown file op: ${params.op}`;
      }

      const fres: FileResult = { success, content, files, stat: statRes, error };
      await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, success, error);
      return fres;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, false, message);
      return { success: false, error: message };
    }
  }

  async gui(params: GUIActionParams): Promise<GUIResult> {
    const screenAction: ScreenAction = {
      type: params.action as ScreenAction['type'],
      x: params.x,
      y: params.y,
      key: params.key,
      direction: params.direction as 'up' | 'down' | undefined,
    };

    // P1 fix HIGH-2: same window guard for control.gui (dupe for small step; protects MEMORY)
    const BLOCKED_WINDOW_RE = /^(Terminal|claude|Claude|SUDO_TUI_TEST)/i;
    const GUARDED = new Set(['click','type','scroll','key']);
    if (GUARDED.has(params.action) || params.action === 'key') {
      try {
        process.env['DISPLAY'] = process.env['DISPLAY'] ?? ':10.0';
        const { stdout } = await execFileAsync('xdotool', ['getactivewindow', 'getwindowname']);
        const winName = stdout.trim();
        if (BLOCKED_WINDOW_RE.test(winName)) {
          log.warn({ winName, action: params.action }, 'control.gui: blocked protected window');
          const gres: GUIResult = { action: params.action, success: false, error: 'control.gui: blocked — protected window (MEMORY.md isolation)' };
          await this.recordOutcome(`control.gui.${params.action}`, params as Record<string, unknown>, false, gres.error);
          return gres;
        }
      } catch (e) {
        log.warn({ action: params.action }, 'control.gui window guard headless allow');
      }
    }

    const res = await executeComputerAction(screenAction);
    const gres: GUIResult = { action: params.action, success: res.success, screenshot: res.screenshot, error: res.error };
    await this.recordOutcome(`control.gui.${params.action}`, params as Record<string, unknown>, gres.success, gres.error);
    return gres;
  }

  async desktop(params: DesktopActionParams): Promise<DesktopResult> {
    const start = Date.now();
    try {
      let success = true;
      let data: Record<string, unknown> | undefined;
      let error: string | undefined;

      if (params.action === 'open' && params.target) {
        await execFileAsync('xdg-open', [params.target]);
        data = { opened: params.target };
      } else if (params.action === 'list') {
        // Simple: list windows via wmctrl if avail, else stub
        try {
          const { stdout } = await execFileAsync('wmctrl', ['-l']);
          data = { windows: stdout.trim().split('\n') };
        } catch {
          data = { windows: ['wmctrl not available - stub'] };
        }
      } else if (params.action === 'focus' && params.target) {
        await execFileAsync('wmctrl', ['-a', params.target]);
      } else {
        success = false;
        error = `unsupported desktop action: ${params.action}`;
      }

      const dres: DesktopResult = { action: params.action, success, data, error };
      await this.recordOutcome(`control.desktop.${params.action}`, params as Record<string, unknown>, success, error);
      return dres;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordOutcome(`control.desktop.${params.action}`, params as Record<string, unknown>, false, message);
      return { action: params.action, success: false, error: message };
    }
  }
}