/**
 * @file bg-shell/index.ts
 * @description Background-shell tool family (gap #10) — Claude-Code-style
 * start / poll / kill for long-running commands. Opt-in via SUDO_BG_SHELL=1.
 *
 * system.shell.start — gate the command through the SAME approval path as
 *   system.exec (EXEC_APPROVAL_MODE/EXEC_APPROVAL_WAIT_MS), then spawn it
 *   non-blocking through the SAME sandbox, returning a shellId. A handle is
 *   created ONLY after approval + a successful spawn — a denied/expired command
 *   never leaves a live process behind.
 * system.shell.poll — incremental stdout/stderr since the last poll + status/exit.
 * system.shell.kill — SIGTERM then SIGKILL (whole process tree).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../../shared/logger.js';
import {
  isAllowlisted,
  requestApproval,
  waitForDecision,
  parseApprovalMode,
} from '../../../../security/approval/index.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { DEFAULT_SANDBOX_POLICY } from '../../../../sandbox/sandbox-types.js';
import { spawnBg } from './spawn-bg.js';
import * as registry from './process-registry.js';

export { killAll, killSession } from './process-registry.js';

const logger = createLogger('system.bg-shell');

// Same two env vars that govern system.exec — one operator config for fg + bg.
const APPROVAL_MODE = parseApprovalMode(process.env['EXEC_APPROVAL_MODE']);
const APPROVAL_WAIT_MS = (() => {
  const raw = process.env['EXEC_APPROVAL_WAIT_MS'];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

/** Gate a command through the approval path. Returns ok, or a ToolResult to return. */
async function gate(command: string, sessionId: string): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const needsApproval =
    APPROVAL_MODE === 'strict' || (APPROVAL_MODE === 'allowlist' && !isAllowlisted(command));
  if (!needsApproval) return { ok: true };

  const approvalId = await requestApproval(command, `background shell requested by session ${sessionId}`);
  const decision = await waitForDecision(approvalId, APPROVAL_WAIT_MS);
  if (decision === 'approved') return { ok: true };
  if (decision === 'denied') {
    return { ok: false, result: { success: false, output: `Command denied by operator: ${command}`, data: { approvalId, decision: 'denied' } } };
  }
  // expired — surface the pending ID so the operator can approve out-of-band.
  return {
    ok: false,
    result: {
      success: false,
      output: `Awaiting human approval for background shell: ${command}\nApproval ID: ${approvalId}\nUse \`sudo-ai approve ${approvalId}\`, then re-run system.shell.start.`,
      data: { approvalId, decision: 'pending' },
    },
  };
}

const startTool: ToolDefinition = {
  name: 'system.shell.start',
  description:
    'Start a long-running shell command in the BACKGROUND and return a shellId immediately '
    + '(use system.shell.poll to read incremental output and system.shell.kill to stop it). '
    + 'Goes through the same approval gate + sandbox as system.exec; in sandboxed mode the '
    + 'effective cwd is /workspace. Use for servers, watchers, builds, or anything you want to '
    + 'keep running while you do other work. Requires SUDO_BG_SHELL=1.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 120_000,
  parameters: {
    command: { type: 'string', required: true, description: 'Shell command to run in the background (via /bin/bash -c).' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = params['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      return { success: false, output: 'system.shell.start: "command" is required and must be a non-empty string.', data: {} };
    }
    // Reserve a concurrency slot BEFORE the (possibly long) approval wait, counting
    // running + in-flight reservations so concurrent starts can't all pass the cap
    // and over-spawn. Released on every exit path via the finally below.
    if (!registry.tryReserve()) {
      return { success: false, output: `system.shell.start: background shell limit reached (${registry.MAX_CONCURRENT} running). Kill one with system.shell.kill or wait.`, data: {} };
    }
    try {
      // FAIL-CLOSED (Feature 8): background shells spawn on the HOST (raw or
      // bwrap) and ignore the docker exec backend. An untrusted turn (trust-tier
      // routing set requireIsolatedBackend) must not start one.
      if (ctx.sandboxPolicy?.requireIsolatedBackend) {
        return {
          success: false,
          output:
            'system.shell.start is unavailable for untrusted sessions (host-spawned background shell). ' +
            'Use system.exec, which runs in an isolated container.',
          data: { error: 'untrusted_tier_refused' },
        };
      }

      const g = await gate(command, ctx.sessionId);
      if (!g.ok) return g.result;

      const useSandbox = ctx.sandboxPolicy?.enabled === true && process.env['SUDO_SANDBOX_DISABLE'] !== '1';
      const workspaceDir = ctx.workspaceDir ?? ctx.workingDir;
      let spawned;
      try {
        spawned = spawnBg({ command, workspaceDir, policy: ctx.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY, useSandbox });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `system.shell.start: spawn failed: ${msg}`, data: {} };
      }
      if (!spawned.child.pid) {
        // Child object exists but the OS never assigned a pid — kill it so it can't
        // linger untracked, then report failure.
        try { spawned.child.kill('SIGKILL'); } catch { /* already gone */ }
        return { success: false, output: 'system.shell.start: child process failed to start.', data: {} };
      }

      const shellId = randomUUID();
      registry.track({ shellId, sessionId: ctx.sessionId, command, child: spawned.child, pgid: spawned.pgid, sandboxed: spawned.sandboxed });
      logger.info({ session: ctx.sessionId, shellId, sandboxed: spawned.sandboxed }, 'background shell started');
      return {
        success: true,
        output: `Started background shell ${shellId} (${spawned.sandboxed ? 'sandboxed' : 'unsandboxed'}). Poll with system.shell.poll, stop with system.shell.kill.`,
        data: { shellId, sandboxed: spawned.sandboxed },
      };
    } finally {
      registry.release();
    }
  },
};

const pollTool: ToolDefinition = {
  name: 'system.shell.poll',
  description:
    'Read NEW stdout/stderr from a background shell since your last poll, plus its status '
    + '(running|exited|killed) and exit code. Output beyond the buffer cap is dropped oldest-first '
    + '(reported as missedBytes). Requires SUDO_BG_SHELL=1.',
  category: 'system',
  timeout: 10_000,
  parameters: {
    shellId: { type: 'string', required: true, description: 'The shellId returned by system.shell.start.' },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const shellId = params['shellId'];
    if (typeof shellId !== 'string' || !shellId) {
      return { success: false, output: 'system.shell.poll: "shellId" is required.', data: {} };
    }
    const handle = registry.get(shellId);
    if (!handle) {
      return { success: false, output: `system.shell.poll: no such shell ${shellId} (unknown or reaped).`, data: {} };
    }
    const { stdout, stderr, missed } = registry.readNew(handle);
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    if (missed > 0) parts.push(`...[${missed} bytes dropped — buffer cap exceeded]`);
    const body = parts.join('').trim();
    return {
      success: true,
      output: `[${handle.status}${handle.exitCode !== null ? ` exit=${handle.exitCode}` : ''}]\n${body || '(no new output)'}`,
      data: { status: handle.status, exitCode: handle.exitCode, stdout, stderr, missedBytes: missed },
    };
  },
};

const killTool: ToolDefinition = {
  name: 'system.shell.kill',
  description: 'Stop a background shell (SIGTERM then SIGKILL) and its whole process tree. Requires SUDO_BG_SHELL=1.',
  category: 'system',
  timeout: 10_000,
  parameters: {
    shellId: { type: 'string', required: true, description: 'The shellId returned by system.shell.start.' },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const shellId = params['shellId'];
    if (typeof shellId !== 'string' || !shellId) {
      return { success: false, output: 'system.shell.kill: "shellId" is required.', data: {} };
    }
    const handle = registry.get(shellId);
    if (!handle) {
      return { success: false, output: `system.shell.kill: no such shell ${shellId}.`, data: {} };
    }
    if (handle.status !== 'running') {
      return { success: true, output: `Shell ${shellId} already ${handle.status}.`, data: { status: handle.status } };
    }
    registry.kill(handle);
    logger.info({ shellId }, 'background shell killed');
    return { success: true, output: `Killed background shell ${shellId}.`, data: { status: 'killed' } };
  },
};

export const BG_SHELL_TOOLS: ToolDefinition[] = [startTool, pollTool, killTool];
