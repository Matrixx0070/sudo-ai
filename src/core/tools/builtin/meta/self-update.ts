/**
 * meta.self-update — SUDO-AI autonomous self-update tool.
 *
 * Allows the brain to update its own codebase without human intervention.
 *
 * Actions:
 *   check        — Run `git status` and `git log --oneline -5` (read-only, no side effects)
 *   pull         — Run `git pull origin main` to fetch latest code
 *   install      — Run `npm install` if package.json changed (detected via git diff)
 *   build        — Run `npm run build` (tsc compile) from the project root
 *   full-update  — Pull + install (if needed) + build + restart service (requires confirm: true)
 *   rollback     — `git reset --hard HEAD~1` then rebuild (requires confirm: true)
 *   status       — Show git log, current branch, last update timestamp from data/self-update.log
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT as RESOLVED_PROJECT_ROOT, DATA_DIR as RESOLVED_DATA_DIR } from '../../../shared/paths.js';
import { scheduleDetachedRestart } from './restart-helper.js';

const logger = createLogger('meta.self-update');

const PROJECT_ROOT = RESOLVED_PROJECT_ROOT;
const DATA_DIR = RESOLVED_DATA_DIR;
const UPDATE_LOG = path.join(DATA_DIR, 'self-update.log');
const MAX_OUTPUT = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function logUpdate(action: string, detail: string): void {
  ensureDataDir();
  const entry = `[${timestamp()}] action=${action} ${detail}\n`;
  appendFileSync(UPDATE_LOG, entry, 'utf-8');
  logger.info({ action, detail }, `self-update: ${action}`);
}

function truncate(str: string): string {
  if (str.length <= MAX_OUTPUT) return str;
  return str.slice(0, MAX_OUTPUT) + `\n... [truncated — ${str.length - MAX_OUTPUT} chars omitted]`;
}

function runCmd(cmd: string, timeoutMs = 120_000): string {
  return execSync(cmd, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runBuild(): string {
  // Build MUST use exact cwd — tsc resolves tsconfig relative to cwd
  const result = execSync('npm run build', {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: 'pipe',
  });
  return typeof result === 'string' ? result.trim() : '';
}

function packageJsonChanged(): boolean {
  try {
    const diff = runCmd('git diff HEAD@{1} HEAD -- package.json package-lock.json 2>/dev/null || git diff HEAD -- package.json package-lock.json');
    return diff.length > 0;
  } catch {
    // If we can't tell, assume yes to be safe
    return true;
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleCheck(): Promise<ToolResult> {
  try {
    const gitStatus = runCmd('git status');
    const gitLog = runCmd('git log --oneline -5');
    const branch = runCmd('git rev-parse --abbrev-ref HEAD');

    logUpdate('check', 'read-only status check');

    const output = [
      `Branch: ${branch}`,
      '',
      '=== git status ===',
      gitStatus,
      '',
      '=== git log (last 5) ===',
      gitLog,
    ].join('\n');

    return {
      success: true,
      output: truncate(output),
      data: { branch, gitStatus, gitLog },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUpdate('check', `FAILED: ${msg}`);
    return { success: false, output: `check failed: ${msg}` };
  }
}

async function handlePull(): Promise<ToolResult> {
  try {
    const output = runCmd('git pull origin main', 60_000);
    logUpdate('pull', `git pull completed`);

    return {
      success: true,
      output: truncate(output),
      data: { action: 'pull' },
      artifacts: [{ path: UPDATE_LOG, action: 'modified' }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUpdate('pull', `FAILED: ${msg}`);
    return { success: false, output: `git pull failed: ${truncate(msg)}` };
  }
}

async function handleInstall(): Promise<ToolResult> {
  try {
    const output = runCmd('npm install', 120_000);
    logUpdate('install', 'npm install completed');

    return {
      success: true,
      output: truncate(output),
      data: { action: 'install' },
      artifacts: [{ path: UPDATE_LOG, action: 'modified' }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUpdate('install', `FAILED: ${msg}`);
    return { success: false, output: `npm install failed: ${truncate(msg)}` };
  }
}

async function handleBuild(): Promise<ToolResult> {
  try {
    const output = runBuild();
    logUpdate('build', 'npm run build SUCCESS');

    return {
      success: true,
      output: truncate(output || 'Build succeeded (no output).'),
      data: { action: 'build' },
      artifacts: [{ path: UPDATE_LOG, action: 'modified' }],
    };
  } catch (err) {
    // Build failed — capture output from both stdout and stderr
    const rawOutput = (() => {
      if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
        const stdout = (err as { stdout?: string }).stdout ?? '';
        const stderr = (err as { stderr?: string }).stderr ?? '';
        return [stdout, stderr].filter(Boolean).join('\n');
      }
      return err instanceof Error ? err.message : String(err);
    })();

    const trimmed = truncate(rawOutput);
    logUpdate('build', `FAILED: ${trimmed.slice(0, 200)}`);
    logger.error({ output: trimmed }, 'Build failed — NOT restarting service');

    return {
      success: false,
      output: `Build FAILED — service will NOT be restarted.\n\nBuild output:\n${trimmed}`,
      data: { action: 'build', buildOutput: trimmed },
    };
  }
}

async function handleFullUpdate(confirm: boolean): Promise<ToolResult> {
  if (!confirm) {
    return {
      success: false,
      output: 'full-update requires confirm: true to prevent accidental updates. Set confirm=true to proceed.',
    };
  }

  logUpdate('full-update', 'started');

  // Step 1: Pull
  const pullResult = await handlePull();
  if (!pullResult.success) {
    logUpdate('full-update', `ABORTED at pull: ${pullResult.output.slice(0, 100)}`);
    return { success: false, output: `full-update aborted at pull step.\n\n${pullResult.output}` };
  }

  // Step 2: Install (conditional)
  let installOutput = '(skipped — package.json unchanged)';
  if (packageJsonChanged()) {
    const installResult = await handleInstall();
    if (!installResult.success) {
      logUpdate('full-update', `ABORTED at install: ${installResult.output.slice(0, 100)}`);
      return { success: false, output: `full-update aborted at install step.\n\n${installResult.output}` };
    }
    installOutput = installResult.output;
  }

  // Step 3: Build
  const buildResult = await handleBuild();
  if (!buildResult.success) {
    logUpdate('full-update', `ABORTED at build — NOT restarting`);
    return {
      success: false,
      output: `full-update aborted: build failed — service NOT restarted.\n\n${buildResult.output}`,
    };
  }

  // Step 4: Restart service — scheduled detached, since restarting our own
  // service synchronously would kill this process mid-command.
  const restart = scheduleDetachedRestart('meta.self-update full-update');
  if (!restart.scheduled) {
    logUpdate('full-update', `restart FAILED to schedule: ${restart.error}`);
    return {
      success: false,
      output: `Build succeeded but service restart could not be scheduled: ${restart.error}\n\nBuild was successful — restart manually if needed.`,
    };
  }
  logUpdate('full-update', `SUCCESS — pull + install + build complete, restart scheduled via ${restart.cmd}`);

  const summary = [
    'full-update COMPLETE',
    '',
    `=== Pull ===\n${pullResult.output}`,
    '',
    `=== Install ===\n${installOutput}`,
    '',
    `=== Build ===\n${buildResult.output}`,
    '',
    `=== Restart ===\nRestart scheduled via \`${restart.cmd}\` (in ~3s) — the service will come back on the new code.`,
  ].join('\n');

  return {
    success: true,
    output: truncate(summary),
    data: { action: 'full-update' },
    artifacts: [{ path: UPDATE_LOG, action: 'modified' }],
  };
}

async function handleRollback(confirm: boolean): Promise<ToolResult> {
  if (!confirm) {
    return {
      success: false,
      output: 'rollback requires confirm: true — this is a destructive operation (git reset --hard HEAD~1). Set confirm=true to proceed.',
    };
  }

  logUpdate('rollback', 'started — git reset --hard HEAD~1');

  // Show what we are rolling back before doing it
  let prevCommitInfo = '';
  try {
    prevCommitInfo = runCmd('git log --oneline -2');
  } catch { /* ignore */ }

  // Perform rollback
  let rollbackOutput = '';
  try {
    rollbackOutput = runCmd('git reset --hard HEAD~1', 30_000);
    logUpdate('rollback', 'git reset --hard HEAD~1 done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUpdate('rollback', `FAILED at reset: ${msg}`);
    return { success: false, output: `rollback failed at git reset: ${msg}` };
  }

  // Rebuild after rollback
  const buildResult = await handleBuild();
  if (!buildResult.success) {
    logUpdate('rollback', 'FAILED at rebuild after reset');
    return {
      success: false,
      output: `Rollback completed (git reset done) but rebuild FAILED.\n\nReset output:\n${rollbackOutput}\n\nBuild error:\n${buildResult.output}`,
    };
  }

  logUpdate('rollback', 'SUCCESS — reset + rebuild complete');

  const summary = [
    'rollback COMPLETE',
    '',
    `=== Previous commits ===\n${prevCommitInfo}`,
    '',
    `=== git reset output ===\n${rollbackOutput}`,
    '',
    `=== Rebuild ===\n${buildResult.output}`,
  ].join('\n');

  return {
    success: true,
    output: truncate(summary),
    data: { action: 'rollback' },
    artifacts: [{ path: UPDATE_LOG, action: 'modified' }],
  };
}

async function handleStatus(): Promise<ToolResult> {
  try {
    const branch = runCmd('git rev-parse --abbrev-ref HEAD');
    const gitLog = runCmd('git log --oneline -10');

    let lastUpdateLog = '(no update log found)';
    if (existsSync(UPDATE_LOG)) {
      const raw = readFileSync(UPDATE_LOG, 'utf-8');
      const lines = raw.trim().split('\n');
      // Show last 20 log lines
      lastUpdateLog = lines.slice(-20).join('\n');
    }

    logUpdate('status', 'status check');

    const output = [
      `Branch: ${branch}`,
      '',
      '=== git log (last 10) ===',
      gitLog,
      '',
      '=== self-update.log (last 20 entries) ===',
      lastUpdateLog,
    ].join('\n');

    return {
      success: true,
      output: truncate(output),
      data: { branch, gitLog, updateLogPath: UPDATE_LOG },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUpdate('status', `FAILED: ${msg}`);
    return { success: false, output: `status failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const selfUpdateTool: ToolDefinition = {
  name: 'meta.self-update',
  description:
    "Update SUDO-AI's own codebase autonomously — git pull, npm build, restart. " +
    'Use check/status for read-only inspection, pull/install/build for individual steps, ' +
    'full-update for the complete update pipeline, or rollback to revert the last commit.',
  category: 'meta',
  timeout: 300_000,

  parameters: {
    action: {
      type: 'string',
      description: 'The update action to perform.',
      required: true,
      enum: ['check', 'pull', 'install', 'build', 'full-update', 'rollback', 'status'],
    },
    confirm: {
      type: 'boolean',
      description: 'Required for destructive actions (full-update, rollback). Must be true to proceed.',
      required: false,
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    const confirm = (params['confirm'] as boolean | undefined) ?? false;

    logger.info({ action, confirm }, 'meta.self-update invoked');

    // MEDIUM-1: Block destructive actions during self-build mode to prevent
    // git reset / pull / build from destroying in-progress self-build work.
    if (process.env['SUDO_SELF_BUILD_MODE'] === '1' && process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] !== '1') {
      const SELFBUILD_BLOCKED: readonly string[] = ['pull', 'full-update', 'rollback', 'build', 'restart'];
      if (SELFBUILD_BLOCKED.includes(action)) {
        return {
          success: false,
          output: `meta.self-update action "${action}" is blocked during self-build mode (SUDO_SELF_BUILD_MODE=1). Use status or check for read-only inspection.`,
        };
      }
    }

    switch (action) {
      case 'check':
        return handleCheck();
      case 'pull':
        return handlePull();
      case 'install':
        return handleInstall();
      case 'build':
        return handleBuild();
      case 'full-update':
        return handleFullUpdate(confirm);
      case 'rollback':
        return handleRollback(confirm);
      case 'status':
        return handleStatus();
      default:
        return {
          success: false,
          output: `Unknown action "${action}". Valid actions: check, pull, install, build, full-update, rollback, status.`,
        };
    }
  },
};
