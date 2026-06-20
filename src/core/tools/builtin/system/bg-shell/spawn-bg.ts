/**
 * @file spawn-bg.ts
 * @description Non-blocking spawn for background shells. Reuses the EXACT arg/env
 * builders that system.exec's sandbox uses (no logic fork) and only swaps the
 * transport from execFileAsync (await-to-completion) to child_process.spawn with
 * piped stdout/stderr, returning a live handle.
 *
 * Two branches mirror runInSandbox's own kill-switch precedence:
 *   - useSandbox=false (SUDO_SANDBOX_DISABLE=1 or no sandbox requested):
 *     raw /bin/bash, DETACHED into its own process group so kill(-pgid) reaps the
 *     whole tree (raw bash has no pid namespace to reap its children).
 *   - useSandbox=true (default): bwrap, NON-detached — bwrap's --unshare-pid +
 *     --die-with-parent make it PID 1 of the inner namespace, so SIGTERM/SIGKILL
 *     of the single bwrap child reaps the entire inner tree.
 *
 * Both branches raise the CPU ulimit (SUDO_BG_SHELL_CPU_SECONDS, default 3600):
 * the sandbox bakes in a 30 CPU-second ulimit that would otherwise SIGKILL every
 * long-running background shell.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  BWRAP_BIN,
  buildBwrapArgs,
  buildSandboxEnv,
  buildUlimitWrappedCommand,
} from '../../../../sandbox/sandbox-runner.js';
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from '../../../../sandbox/sandbox-types.js';

const BG_CPU_SECONDS = (() => {
  const raw = process.env['SUDO_BG_SHELL_CPU_SECONDS'];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3600;
})();

export interface BgSpawnResult {
  child: ChildProcess;
  /** Process-group id for kill(-pgid) on the raw path; null for the bwrap path. */
  pgid: number | null;
  sandboxed: boolean;
}

export function spawnBg(opts: {
  command: string;
  workspaceDir: string;
  policy?: SandboxPolicy;
  useSandbox: boolean;
}): BgSpawnResult {
  const base = opts.policy ?? DEFAULT_SANDBOX_POLICY;
  // Clone + raise the CPU ulimit before building args/ulimits.
  const policy: SandboxPolicy = { ...base, cpuSeconds: BG_CPU_SECONDS };

  if (!opts.useSandbox) {
    const child = spawn('/bin/bash', ['-c', buildUlimitWrappedCommand(opts.command, policy)], {
      cwd: opts.workspaceDir,
      env: buildSandboxEnv(policy),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // pgid = the detached group leader's pid. If the OS never assigned a pid
    // (extremely rare), pgid is null and the registry falls back to child.kill —
    // still correct, just without the group-kill semantics.
    return { child, pgid: child.pid ?? null, sandboxed: false };
  }

  const child = spawn(BWRAP_BIN, buildBwrapArgs(opts.command, opts.workspaceDir, policy), {
    env: buildSandboxEnv(policy),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, pgid: null, sandboxed: true };
}
