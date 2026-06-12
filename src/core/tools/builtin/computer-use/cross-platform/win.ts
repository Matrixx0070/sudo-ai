/**
 * @file win.ts
 * @description Win backend for IComputerUse (powershell + node fs cross + gui stubs).
 *
 * Windows backend (experimental): PowerShell + node fs, with gui/desktop stubbed.
 * exec via PowerShell, cross-platform file ops, basic gui/desktop.
 * Learner on every outcome; monitoring/self-repair hook.
 * Sandbox: shim (no bwrap; policy via limits where possible) -- expanded in sandbox/*.
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
} from './types.js';
// Fix HIGH-1: use buildSandboxEnv for scrub (SECRET_DENYLIST + allowlist) instead of raw process.env on cross exec
import { buildSandboxEnv } from '../../../../sandbox/sandbox-runner.js';
import { DEFAULT_SANDBOX_POLICY } from '../../../../sandbox/sandbox-types.js';

const log = createLogger('control:cross:win');
const execFileAsync = promisify(execFile);

export class WinComputerUse implements IComputerUse {
  private readonly config: ComputerUseConfig;
  private readonly triggerRepair?: (task: string, mode?: 'fix' | 'refactor') => Promise<{ success: boolean; output: string }>;

  constructor(config: ComputerUseConfig = {}) {
    this.config = config;
    this.triggerRepair = config.triggerRepair;
    log.info({ platform: 'win' }, 'WinComputerUse initialized (experimental)');
  }

  private async recordOutcome(toolName: string, args: Record<string, unknown>, success: boolean, error?: string): Promise<void> {
    if (this.config.learner) {
      try {
        this.config.learner.onToolResult(toolName, args, success, error, this.config.sessionId, undefined, 'control,cross-platform,win');
      } catch {}
    }
    if (!success && error && error !== 'kill-switch' && this.triggerRepair && process.env['SUDO_KAIROS_ARSENAL_TRIGGER_DISABLE'] !== '1') {
      try {
        await this.triggerRepair(`KAIROS: control ${toolName} win degraded: ${error.slice(0,100)}`, 'fix');
      } catch {}
    }
  }

  private killSwitchActive(): boolean {
    return process.env[this.config.killSwitchEnv || 'SUDO_CROSS_CONTROL_DISABLE'] === '1';
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const args = { cmd, opts };
    if (this.killSwitchActive()) {
      await this.recordOutcome('control.exec', args, false, 'kill-switch');
      return { success: false, stdout: '', stderr: 'kill-switch', exitCode: 1, durationMs: Date.now() - start, platform: 'win' };
    }
    try {
      // Fix HIGH-1: scrub secrets via buildSandboxEnv (never full process.env for control.exec on win)
      const policy = this.config.sandboxPolicy || DEFAULT_SANDBOX_POLICY;
      const baseEnv = buildSandboxEnv(policy);
      const childEnv = opts.env ? { ...baseEnv, ...opts.env } : baseEnv;
      const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        cwd: opts.cwd,
        env: childEnv,
        timeout: opts.timeout || 30000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const res: ExecResult = { success: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, durationMs: Date.now() - start, platform: 'win' };
      await this.recordOutcome('control.exec', args, true);
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.recordOutcome('control.exec', args, false, msg);
      return { success: false, stdout: '', stderr: msg, exitCode: 1, durationMs: Date.now() - start, platform: 'win' };
    }
  }

  async browser(params: BrowserActionParams): Promise<BrowserResult> {
    if (this.killSwitchActive()) {
      await this.recordOutcome(`control.browser.${params.action}`, params as Record<string, unknown>, false, 'kill-switch');
      return { action: params.action, success: false, error: 'kill-switch' };
    }
    // Do not report win browser stub (no-op) as success; accurate reporting for cross-platform.
    const err = 'control.browser stub on win (P1 refine: no-op not reported success per Codex; real via powershell in full cross)';
    await this.recordOutcome(`control.browser.${params.action}`, params as Record<string, unknown>, false, err);
    return { action: params.action, success: false, error: err };
  }

  async file(params: FileOpParams): Promise<FileResult> {
    if (this.killSwitchActive()) {
      await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, false, 'kill-switch');
      return { success: false, error: 'kill-switch' };
    }
    try {
      const abs = path.resolve(params.path);
      // Fix HIGH-3: denylist for win control.file (SOUL exfil protection)
      // Narrow to sensitive subpaths/workspace-rel (not broad /root/home blocking normal ops); same list as linux for cross consistency.
      const SENSITIVE_DENY = ['/etc/shadow', '/etc/passwd', '/root/.ssh', '/home/.ssh', 'MEMORY.md', 'data/credentials', '/root/.aws', '/root/.config/sudo-ai', '/boot', '/var/lib/sudo'];
      const norm = abs.toLowerCase();
      if (SENSITIVE_DENY.some(s => norm.includes(s.toLowerCase()))) {
        const em = 'control.file: sensitive blocked (SOUL)';
        await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, false, em);
        return { success: false, error: em };
      }
      let success = true, content: string | undefined, files: string[] | undefined, statRes: any, error: string | undefined;
      if (params.op === 'read') content = await readFile(abs, 'utf8');
      else if (params.op === 'write' && params.content != null) await writeFile(abs, params.content, 'utf8');
      else if (params.op === 'list') files = await readdir(abs);
      else if (params.op === 'stat') { const s = await stat(abs); statRes = { size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() }; }
      else if (params.op === 'delete') await rm(abs, { recursive: true, force: true });
      else { success = false; error = 'unknown op'; }
      const fres = { success, content, files, stat: statRes, error };
      await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, success, error);
      return fres;
    } catch (e: any) {
      await this.recordOutcome(`control.file.${params.op}`, params as unknown as Record<string, unknown>, false, e.message);
      return { success: false, error: e.message };
    }
  }

  async gui(params: GUIActionParams): Promise<GUIResult> {
    if (this.killSwitchActive()) {
      await this.recordOutcome(`control.gui.${params.action}`, params as Record<string, unknown>, false, 'kill-switch');
      return { action: params.action, success: false, error: 'kill-switch' };
    }
    // Do not report win gui stub (no-op) as success; accurate reporting for cross-platform.
    const err = 'control.gui stub on win (P1 refine: no-op not reported success per Codex; real via powershell SendKeys in full)';
    await this.recordOutcome(`control.gui.${params.action}`, params as Record<string, unknown>, false, err);
    return { action: params.action, success: false, error: err };
  }

  async desktop(params: DesktopActionParams): Promise<DesktopResult> {
    if (this.killSwitchActive()) {
      await this.recordOutcome(`control.desktop.${params.action}`, params as Record<string, unknown>, false, 'kill-switch');
      return { action: params.action, success: false, error: 'kill-switch' };
    }
    // Do not report win desktop stub (no-op) as success; accurate reporting for cross-platform.
    const err = 'control.desktop stub on win (P1 refine: no-op not reported success per Codex)';
    await this.recordOutcome(`control.desktop.${params.action}`, params as Record<string, unknown>, false, err);
    return { action: params.action, success: false, error: err, data: { target: params.target } };
  }
}