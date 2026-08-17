/**
 * @file shell-exec-runner.ts
 * @description Execution mechanics for `system.exec`: output truncation, the
 * raw `/bin/bash -c` runner, the bwrap-sandboxed runner, and the sandboxed
 * result shape.
 *
 * Split out of shell-exec.ts so that file keeps only DISPATCH + POLICY (which
 * authority applies, sandbox vs host, approval in gated mode) while the
 * mechanics of actually running a command live here.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../../../shared/logger.js';
import type { ToolResult } from '../../types.js';
import type { SandboxPolicy } from '../../../sandbox/sandbox-types.js';
import { runInSandbox } from '../../../sandbox/sandbox-runner.js';
import { clampHeadTail } from '../../../shared/head-tail-buffer.js';

const logger = createLogger('system.exec');

export const MAX_OUTPUT = 8_000;

/**
 * Appended to every sandboxed result. Without it the model reported "Done —
 * file written" for a write that only existed inside the sandbox's mount
 * namespace (observed live 2026-08-16): a contained effect must never read as
 * a host effect.
 */
export const SANDBOX_NOTE =
  '\n[sandboxed: ran in an isolated namespace on a copy of the workspace — ' +
  'changes to paths outside the session workspace did NOT affect the host]';

export function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  // Keep both ends: the head shows what the command started doing, the tail
  // carries the error message and exit status — the part the model most needs
  // to recover. Split the MAX_OUTPUT budget 50/50 across head and tail.
  const half = Math.floor(MAX_OUTPUT / 2);
  const { text: clamped, truncated } = clampHeadTail(text, {
    headBudget: half,
    tailBudget: MAX_OUTPUT - half,
    elisionMarker: `...[truncated — ${text.length} total chars, {n} elided]...`,
  });
  return { text: clamped, truncated };
}

// ---------------------------------------------------------------------------
// Helper: run /bin/bash -c <command>
// ---------------------------------------------------------------------------

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/bash',
      ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: process.env,
        signal,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const code =
          typeof (err as NodeJS.ErrnoException & { code?: unknown })['code'] === 'number'
            ? ((err as unknown as { code: number }).code)
            : 1;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : err.message,
          exitCode: code,
        });
      },
    );
    if (signal) {
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: run command inside bwrap sandbox via sandbox-runner
// ---------------------------------------------------------------------------

/**
 * Run a shell command through the bubblewrap sandbox.
 *
 * Delegates to `runInSandbox` from sandbox-runner.ts (Builder A).
 * When SUDO_SANDBOX_DISABLE=1, sandbox-runner falls back to raw execFile
 * and emits a loud warning on every call.
 *
 * Note: inside the sandbox the effective cwd is always /workspace (enforced by
 * --chdir /workspace in the bwrap invocation), regardless of any `cwd` param
 * passed in by the agent.
 */
export async function runSandboxedShell(
  command: string,
  workspaceDir: string,
  timeoutMs: number,
  policy: SandboxPolicy,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runInSandbox({
    command,
    workspaceDir,
    policy,
    timeoutMs,
    signal,
  });
}


export 
async function runApprovedCommandSandboxed(
  command: string,
  workspaceDir: string,
  timeoutMs: number,
  sessionId: string,
  start: number,
  policy: SandboxPolicy,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const { stdout, stderr, exitCode } = await runSandboxedShell(
      command,
      workspaceDir,
      timeoutMs,
      policy,
      signal,
    );
    const durationMs = Date.now() - start;

    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const { text: output, truncated } = truncate(combined || '(no output)');
    const success = exitCode === 0;

    logger.info(
      { session: sessionId, exitCode, durationMs, truncated, sandboxed: true },
      'Sandboxed shell command completed',
    );

    const body = success ? output : `Command exited with code ${exitCode}:\n${output}`;

    return {
      success,
      output: body + SANDBOX_NOTE,
      data: { exitCode, durationMs, truncated, sandboxed: true },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ session: sessionId, command, err: err instanceof Error ? err.message : String(err) }, 'Sandboxed shell command threw unexpectedly');
    return { success: false, output: `system.exec sandbox error: ${msg}`, data: { exitCode: -1, sandboxed: true } };
  }
}

