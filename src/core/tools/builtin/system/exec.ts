/**
 * Shared shell-execution helper for system tools.
 *
 * All commands MUST go through `runCmd` — never use `child_process.exec` or
 * shell-interpolated strings.  `execFile` is used exclusively so that
 * arguments are passed as an array and never interpreted by a shell.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SystemError } from '../../../shared/errors.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** AbortSignal forwarded from ToolContext (for timeout support). */
  signal?: AbortSignal;
  /** Working directory for the child process. */
  cwd?: string;
  /** Maximum buffer size in bytes. Default 8 MB. */
  maxBuffer?: number;
  /** Environment variables (merged with process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * When true, a non-zero exit code does NOT throw.
   * The raw stderr / stdout are returned alongside the exit code.
   */
  allowFailure?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Execute `bin` with `args` using execFile.
 *
 * @param bin  - Binary name or absolute path (no shell metacharacters).
 * @param args - Argument array — NEVER join these into a string.
 * @param opts - Execution options.
 * @returns Parsed stdout, stderr, and exit code.
 * @throws {SystemError} On ENOENT (binary not installed) or non-zero exit
 *         (unless `allowFailure` is true).
 */
export async function runCmd(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { signal, cwd, maxBuffer = 8 * 1024 * 1024, env, allowFailure = false } = opts;

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      signal,
      cwd,
      maxBuffer,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    // ENOENT means the binary is not installed.
    if (isEnoent(err)) {
      throw new SystemError(
        `Command not found: ${bin}. Is it installed?`,
        'cmd_not_found',
        { bin, args },
      );
    }

    // execFile rejects with an object that carries stdout/stderr/code.
    const { stdout, stderr, code } = extractExecError(err);
    const exitCode = typeof code === 'number' ? code : 1;

    if (allowFailure) {
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    }

    throw new SystemError(
      `Command failed: ${bin} (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      'cmd_failed',
      { bin, args, exitCode, stderr, stdout },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

interface ExecError {
  stdout: string;
  stderr: string;
  code: number | null;
}

function extractExecError(err: unknown): ExecError {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    return {
      stdout: typeof e['stdout'] === 'string' ? e['stdout'] : '',
      stderr: typeof e['stderr'] === 'string' ? e['stderr'] : String(err),
      code: typeof e['code'] === 'number' ? e['code'] : null,
    };
  }
  return { stdout: '', stderr: String(err), code: null };
}

/**
 * Return a user-friendly "not installed" ToolResult when a SystemError with
 * code `system_cmd_not_found` is caught.  Re-throws all other errors.
 */
export function handleNotInstalled(
  err: unknown,
  toolName: string,
): { success: false; output: string; data: { error: string } } | never {
  if (
    err instanceof SystemError &&
    err.code === 'system_cmd_not_found'
  ) {
    return {
      success: false,
      output: err.message,
      data: { error: `not_installed: ${toolName}` },
    };
  }
  throw err;
}
