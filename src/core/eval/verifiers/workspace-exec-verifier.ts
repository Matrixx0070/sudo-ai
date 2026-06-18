/**
 * @file workspace-exec-verifier.ts
 * @description Runs a shell command (typically a test harness like `pytest`) inside
 * the agent's workspace and returns a VerifierResult based on exit code.
 *
 * Distinct from {@link ExecVerifier} which extracts code from an agent's TEXT response
 * and writes a script. WorkspaceExecVerifier reads the agent's WORKSPACE — the files
 * the agent already edited via its tools — and runs the harness over them.
 */

import { createLogger } from '../../shared/logger.js';
import { DEFAULT_SANDBOX_POLICY, runInSandbox } from '../../sandbox/index.js';
import type { VerifierResult } from '../../shared/wave10-types.js';
import { isSandboxAvailable } from './exec-verifier.js';

const log = createLogger('eval:workspace-exec-verifier');

export interface WorkspaceExecVerifierOptions {
  /** Shell command to run inside the workspace (cwd is the workspaceDir). */
  command: string;
  /** Per-run timeout in ms. Default 15_000. */
  timeoutMs?: number;
}

/**
 * Run the test command and produce a verdict.
 * Falls back to a non-sandboxed direct exec when bwrap is unavailable.
 */
export async function verifyWorkspaceExec(
  workspaceDir: string,
  opts: WorkspaceExecVerifierOptions,
): Promise<VerifierResult> {
  const { command, timeoutMs = 15_000 } = opts;

  if (!isSandboxAvailable()) {
    return {
      passed: false,
      score: 0,
      detail: 'sandbox unavailable (bwrap not installed or restricted)',
      type: 'workspace-exec',
    };
  }

  try {
    const result = await runInSandbox({
      command,
      workspaceDir,
      // Use host network — unprivileged runners can't unshare-net (loopback EPERM).
      policy: { ...DEFAULT_SANDBOX_POLICY, network: 'host' },
      timeoutMs,
    });

    const passed = result.exitCode === 0;
    const score = passed ? 1 : 0;
    const detail = passed
      ? 'all tests passed'
      : trim(`exit=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`, 2_000);

    return { passed, score, detail, type: 'workspace-exec' };
  } catch (err) {
    log.warn({ err: String(err) }, 'WorkspaceExecVerifier: runInSandbox threw');
    return {
      passed: false,
      score: 0,
      detail: trim(`sandbox error: ${String(err)}`, 2_000),
      type: 'workspace-exec',
    };
  }
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + ' …[truncated]';
}
