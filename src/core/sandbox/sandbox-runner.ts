/**
 * @file sandbox/sandbox-runner.ts
 * @description bwrap process isolation runner.
 *
 * runInSandbox: spawns a command inside bubblewrap.
 *   Falls back to raw execFile when SUDO_SANDBOX_DISABLE=1.
 *   On every fallback call logs a loud warning — not just at startup.
 *
 * buildBwrapArgs: exported for unit testing.
 * buildSandboxEnv: exported for unit testing.
 *
 * Security invariants:
 *   - buildSandboxEnv reads ONLY allowlisted keys from process.env.
 *   - HOME is always /workspace, USER is always 'sandbox'.
 *   - lib64 bind is conditional on existsSync('/lib64').
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import {
  type SandboxPolicy,
  ENV_ALLOWLIST_BASE,
  SECRET_ENV_DENYLIST,
  SandboxPolicyError,
} from './sandbox-types.js';
import { validateBindPath } from './sandbox-policy.js';

const log = createLogger('sandbox:runner');
const execFileAsync = promisify(execFile);

const BWRAP_BIN = '/usr/bin/bwrap';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunInSandboxOptions {
  command: string;
  workspaceDir: string;
  policy: SandboxPolicy;
  timeoutMs: number;
  signal?: AbortSignal;
  // P1 cross-platform
  platform?: 'linux' | 'win' | 'mac';
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// buildSandboxEnv
// ---------------------------------------------------------------------------

/**
 * Build the filtered env object passed to bwrap child process.
 * ONLY ENV_ALLOWLIST_BASE keys + policy.allowedEnvVars are copied from
 * process.env. HOME and USER are always overridden. No other keys pass through.
 */
/** Pattern matching variable names that indicate secrets. */
const SECRET_NAME_PATTERN = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_AUTH|_CREDENTIAL|_APIKEY)$/i;

/** Check if an env var name is denylisted as a secret. */
function isSecretEnvVar(name: string): boolean {
  if ((SECRET_ENV_DENYLIST as ReadonlyArray<string>).includes(name)) return true;
  if (SECRET_NAME_PATTERN.test(name)) return true;
  return false;
}

export function buildSandboxEnv(policy: SandboxPolicy): NodeJS.ProcessEnv {
  const allowedKeys = [
    ...ENV_ALLOWLIST_BASE,
    ...(policy.allowedEnvVars ?? []),
  ];

  const env: NodeJS.ProcessEnv = {};

  for (const key of allowedKeys) {
    if (isSecretEnvVar(key)) {
      log.warn({ key }, 'buildSandboxEnv: secret env var denied');
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Always override — never inherited from process.env.
  env['HOME'] = '/workspace';
  env['USER'] = 'sandbox';

  return env;
}

// ---------------------------------------------------------------------------
// buildBwrapArgs
// ---------------------------------------------------------------------------

/**
 * Build the argv array for bwrap (does NOT include the bwrap binary itself).
 * The returned array is ready to pass as the args param to execFile(BWRAP_BIN, ...).
 *
 * @param _existsSync - optional override for existsSync (for unit testing only)
 * @param _realpathSync - optional override for realpathSync (for unit testing only)
 */
export function buildBwrapArgs(
  command: string,
  workspaceDir: string,
  policy: SandboxPolicy,
  _existsSync?: (p: string) => boolean,
  _realpathSync?: (p: string) => string,
  _platform?: string, // P1 cross (ignored for bwrap linux-only)
): string[] {
  const checkExists = _existsSync ?? existsSync;
  // FIX #4: resolve symlinks before validating bind paths to prevent symlink bypass
  const resolveRealpath = _realpathSync ?? realpathSync;
  const args: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
  ];

  if (policy.network === 'none') {
    args.push('--unshare-net');
  }

  // Workspace: writable bind
  args.push('--bind', workspaceDir, '/workspace');

  // Core read-only system paths
  args.push('--ro-bind', '/usr', '/usr');
  args.push('--ro-bind', '/bin', '/bin');
  args.push('--ro-bind', '/lib', '/lib');

  // lib64 is conditional — not present on all Ubuntu configs
  if (checkExists('/lib64')) {
    args.push('--ro-bind', '/lib64', '/lib64');
  }

  // Pseudo-filesystems
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');
  args.push('--tmpfs', '/tmp');

  // Working directory inside sandbox
  args.push('--chdir', '/workspace');

  // Extra read-only binds from policy — resolve symlinks + validate before appending
  for (const bind of policy.extraReadOnlyBinds ?? []) {
    // FIX #4: resolve symlinks first so a symlink pointing to /etc won't bypass denylist
    let resolvedBind: string;
    try {
      resolvedBind = resolveRealpath(bind);
    } catch {
      throw new SandboxPolicyError(
        `buildBwrapArgs: bind path does not exist: ${JSON.stringify(bind)}`,
      );
    }
    if (!validateBindPath(resolvedBind)) {
      throw new SandboxPolicyError(
        `buildBwrapArgs: resolved bind path unsafe: ${JSON.stringify(resolvedBind)}`,
      );
    }
    args.push('--ro-bind', resolvedBind, resolvedBind);
  }

  // Extra writable binds from policy — resolve symlinks + validate before appending
  for (const bind of policy.extraWritableBinds ?? []) {
    // FIX #4: resolve symlinks first so a symlink pointing to /etc won't bypass denylist
    let resolvedBind: string;
    try {
      resolvedBind = resolveRealpath(bind);
    } catch {
      throw new SandboxPolicyError(
        `buildBwrapArgs: bind path does not exist: ${JSON.stringify(bind)}`,
      );
    }
    if (!validateBindPath(resolvedBind)) {
      throw new SandboxPolicyError(
        `buildBwrapArgs: resolved bind path unsafe: ${JSON.stringify(resolvedBind)}`,
      );
    }
    args.push('--bind', resolvedBind, resolvedBind);
  }

  // Command separator
  args.push('--');
  args.push('/bin/bash', '-c');

  // Ulimit wrapper: set both soft AND hard limits (-SH) so the child cannot raise them.
  // -t cpu seconds, -f file blocks (maxFileMB * 2048), -u processes, -v virtual memory (MB * 1024)
  const cpuSeconds = policy.cpuSeconds ?? 30;
  const maxFileMB = policy.maxFileMB ?? 100;
  const memoryMB = policy.memoryMB ?? 512;
  const fileBlocks = maxFileMB * 2048;
  const kb = memoryMB * 1024;
  const shellCmd =
    `ulimit -SHt ${cpuSeconds}; ` +
    `ulimit -SHf ${fileBlocks}; ` +
    `ulimit -SHu 64; ` +
    `ulimit -SHv ${kb}; ` +
    command;

  args.push(shellCmd);

  return args;
}

// ---------------------------------------------------------------------------
// runInSandbox
// ---------------------------------------------------------------------------

/**
 * Run a shell command inside bwrap.
 * When SUDO_SANDBOX_DISABLE=1, falls back to raw execFile with a per-call warning.
 */
export async function runInSandbox(
  opts: RunInSandboxOptions,
): Promise<SandboxRunResult> {
  const { command, workspaceDir, policy, timeoutMs, signal, platform } = opts;

  const effectivePlatform = platform || policy.platform || 'linux';
  if (effectivePlatform !== 'linux' || process.env['SUDO_SANDBOX_DISABLE'] === '1') {
    // P1 hardened cross shim: always scrub via buildSandboxEnv; non-linux = host exec (full power per SOUL but logged); route control.file/gui via denylist in backends
    log.warn({ platform: effectivePlatform }, 'cross-platform sandbox shim (non-linux or disabled) - native with FULL env/policy scrub; file/gui/desktop control have separate denylists');
    return runUnsandboxed(command, workspaceDir, policy, timeoutMs, signal);
  }

  if (process.env['SUDO_SANDBOX_DISABLE'] === '1') {
    log.warn(
      'SUDO_SANDBOX_DISABLE=1 — bwrap disabled, running unsandboxed. ' +
        'This is a security risk. Do not use in production.',
    );
    return runUnsandboxed(command, workspaceDir, policy, timeoutMs, signal);
  }

  const bwrapArgs = buildBwrapArgs(command, workspaceDir, policy);
  const env = buildSandboxEnv(policy);

  const execOptions: Parameters<typeof execFileAsync>[2] = {
    env,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    signal,
  };

  try {
    const result = await execFileAsync(BWRAP_BIN, bwrapArgs, execOptions);
    const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
    const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr);
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
      status?: number;
    };

    // execFile rejects on nonzero exit — capture stdout/stderr from the error
    const outRaw = error.stdout;
    const errRaw = error.stderr;
    const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
    const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';

    if (
      error.code === 'ABORT_ERR' ||
      error.code === 'ERR_ABORT' ||
      signal?.aborted
    ) {
      return { stdout, stderr: stderr || 'Process aborted', exitCode: 130 };
    }

    // Numeric exit code from the child process
    const exitCode = typeof error.status === 'number' ? error.status : 1;

    return { stdout, stderr, exitCode };
  }
}

// ---------------------------------------------------------------------------
// Internal: unsandboxed fallback
// ---------------------------------------------------------------------------

async function runUnsandboxed(
  command: string,
  cwd: string,
  policy: SandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  try {
    const env = buildSandboxEnv(policy);
    const result = await execFileAsync(
      '/bin/bash',
      ['-c', command],
      { cwd, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, signal },
    );
    const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
    const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr);
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
    };
    const outRaw = error.stdout;
    const errRaw = error.stderr;
    const stdout = typeof outRaw === 'string' ? outRaw : outRaw ? String(outRaw) : '';
    const stderr = typeof errRaw === 'string' ? errRaw : errRaw ? String(errRaw) : '';
    const exitCode = typeof error.status === 'number' ? error.status : 1;
    return { stdout, stderr, exitCode };
  }
}
