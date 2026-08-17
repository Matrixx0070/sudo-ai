/**
 * system.exec — Execute any shell command via /bin/bash -c.
 *
 * The most powerful tool in the system toolset. Runs arbitrary shell commands
 * and returns combined stdout + stderr, truncated to 8 000 characters.
 * Uses execFile(/bin/bash) so the shell handles pipes, redirects, builtins,
 * etc., while still going through execFile (not exec) for argument safety.
 *
 * AUTHORITY: security/execution-authority.ts decides whether this tool may run
 * without asking. Under the default autonomous mode nothing prompts and
 * EXEC_APPROVAL_MODE / EXEC_APPROVAL_WAIT_MS apply only in gated mode. Under
 * god mode a verified-owner command also bypasses the sandbox and runs on the
 * real host. See docs/EXECUTION_AUTHORITY.md.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { SandboxPolicy } from '../../../sandbox/sandbox-types.js';
import {
  isAllowlisted,
  requestApproval,
  waitForDecision,
  parseApprovalMode,
} from '../../../security/approval/index.js';
import { authorize, isGodMode } from '../../../security/execution-authority.js';
import {
  MAX_OUTPUT,
  truncate,
  runShell,
  runApprovedCommandSandboxed,
} from './shell-exec-runner.js';
import {
  checkRepoCommand,
  repoExecEnabled,
  runRepoPipeline,
  auditExec,
} from '../../../security/approval/repo-allowlist.js';

const logger = createLogger('system.exec');

const DEFAULT_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Approval gate configuration (evaluated once at module load)
// ---------------------------------------------------------------------------

const APPROVAL_MODE = parseApprovalMode(process.env['EXEC_APPROVAL_MODE']);

const APPROVAL_WAIT_MS = (() => {
  const raw = process.env['EXEC_APPROVAL_WAIT_MS'];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

/** Human-facing TTL shown in the pending message (30 minutes). */
const APPROVAL_TTL_DISPLAY = '30 min';

if (APPROVAL_MODE === 'off') {
  logger.warn(
    { mode: APPROVAL_MODE },
    'system.exec: EXEC_APPROVAL_MODE=off — approval gate disabled. All commands run unrestricted.',
  );
}

// ---------------------------------------------------------------------------
// Helper: truncate combined output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: pending-approval ToolResult (returned to agent when no decision yet)
// ---------------------------------------------------------------------------

function pendingResult(command: string, approvalId: string): ToolResult {
  return {
    success: false,
    output: [
      `Awaiting human approval for: ${command}`,
      `Approval ID: ${approvalId}`,
      `Use \`sudo-ai approve ${approvalId}\` to allow, or \`sudo-ai deny ${approvalId}\`.`,
      `Timeout: ${APPROVAL_TTL_DISPLAY}.`,
    ].join('\n'),
    data: { approvalId, decision: 'pending' },
  };
}

// ---------------------------------------------------------------------------
// Execute an already-approved (or directly allowlisted) command
// ---------------------------------------------------------------------------

async function runApprovedCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  sessionId: string,
  start: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const { stdout, stderr, exitCode } = await runShell(command, cwd, timeoutMs, signal);
    const durationMs = Date.now() - start;

    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const { text: output, truncated } = truncate(combined || '(no output)');
    const success = exitCode === 0;

    logger.info({ session: sessionId, exitCode, durationMs, truncated }, 'Shell command completed');

    return {
      success,
      output: success ? output : `Command exited with code ${exitCode}:\n${output}`,
      data: { exitCode, durationMs, truncated },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ session: sessionId, command, err: err instanceof Error ? err.message : String(err) }, 'Shell command threw unexpectedly');
    return { success: false, output: `system.exec error: ${msg}`, data: { exitCode: -1 } };
  }
}

// ---------------------------------------------------------------------------
// Approval gate — determines whether to run or request approval
// ---------------------------------------------------------------------------

interface GateOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  sessionId: string;
  signal?: AbortSignal;
  /** When provided and enabled, routes approved commands through bwrap sandbox. */
  sandboxPolicy?: SandboxPolicy;
  /** Provisioned workspace dir for the sandbox. REQUIRED when sandboxPolicy.enabled is true. */
  workspaceDir: string;
  /** True when the turn is attributable to the VERIFIED owner (god mode). */
  ownerVerified?: boolean;
}

async function executeWithGate(opts: GateOptions): Promise<ToolResult> {
  const { command, cwd, timeoutMs, sessionId, signal, sandboxPolicy, workspaceDir, ownerVerified } = opts;
  const start = Date.now();

  if (sandboxPolicy?.enabled && !workspaceDir) {
    throw new Error('workspaceDir required when sandbox enabled');
  }

  // Central execution authority decides first. In the default autonomous mode
  // no surface may prompt, so EXEC_APPROVAL_MODE is bypassed entirely (it
  // stays authoritative in gated mode). Resolved per call — unlike the
  // module-level APPROVAL_MODE const, a live posture change applies to the
  // next command instead of requiring a daemon restart.
  const authority = authorize({
    surface: 'shell-exec',
    action: 'system.exec',
    command,
    ownerVerified: ownerVerified === true,
  });
  if (!authority.proceed && !authority.requiresPrompt) {
    logger.error(
      { session: sessionId, command, reason: authority.reason },
      'system.exec: refused by execution authority',
    );
    return {
      success: false,
      output: `Refused: ${command}\nWhole-system destruction is refused by containment policy ` +
        `(no prompt was shown). Set SUDO_AUTHORITY_ALLOW_CATASTROPHIC=1 to lift.`,
      data: { refused: true, reason: authority.reason, durationMs: Date.now() - start },
    };
  }

  const needsApproval =
    authority.requiresPrompt &&
    (APPROVAL_MODE === 'strict' ||
      (APPROVAL_MODE === 'allowlist' && !isAllowlisted(command)));

  // GOD MODE (owner directive): a VERIFIED-OWNER turn runs on the REAL HOST.
  // Lifting the approval layer alone left owner commands inside the bwrap
  // namespace — `touch /etc/x` reported success while the host was untouched.
  // Owner only; every unattributed caller keeps the sandbox. See
  // docs/EXECUTION_AUTHORITY.md.
  const hostAccess = isGodMode() && ownerVerified === true;

  if (!needsApproval) {
    logger.info({ session: sessionId, command, cwd, timeoutMs, hostAccess }, 'Executing shell command');
    if (sandboxPolicy?.enabled && !hostAccess) {
      const wsDir = workspaceDir;
      logger.info({ session: sessionId, wsDir }, 'Dispatching to bwrap sandbox');
      return runApprovedCommandSandboxed(command, wsDir, timeoutMs, sessionId, start, sandboxPolicy, signal);
    }
    if (hostAccess && sandboxPolicy?.enabled) {
      logger.warn({ session: sessionId, command: command.slice(0, 200) },
        'GOD MODE: owner-verified command bypassing the sandbox — executing on the real host');
    }
    return runApprovedCommand(command, cwd, timeoutMs, sessionId, start, signal);
  }

  logger.info({ session: sessionId, command }, 'system.exec: approval required — requesting');
  const approvalId = await requestApproval(command, `Requested by session ${sessionId}`);
  const decision = await waitForDecision(approvalId, APPROVAL_WAIT_MS);

  if (decision === 'approved') {
    logger.info({ session: sessionId, approvalId }, 'system.exec: command approved — executing');
    if (sandboxPolicy?.enabled) {
      const wsDir = workspaceDir;
      logger.info({ session: sessionId, wsDir }, 'Dispatching approved command to bwrap sandbox');
      return runApprovedCommandSandboxed(command, wsDir, timeoutMs, sessionId, start, sandboxPolicy, signal);
    }
    return runApprovedCommand(command, cwd, timeoutMs, sessionId, start, signal);
  }

  if (decision === 'denied') {
    logger.info({ session: sessionId, approvalId }, 'system.exec: command denied by operator');
    return {
      success: false,
      output: `Command denied by operator: ${command}`,
      data: { approvalId, decision: 'denied' },
    };
  }

  // 'expired': no decision within wait window — surface the ID
  logger.info({ session: sessionId, approvalId }, 'system.exec: approval wait expired — returning pending');
  return pendingResult(command, approvalId);
}

// ---------------------------------------------------------------------------
// Repo target — run an allowlisted command against the REAL repo (no sandbox)
// ---------------------------------------------------------------------------

/**
 * Handle system.exec target:'repo'. Gated by SUDO_REPO_EXEC=1 AND the repo
 * allowlist (read/verify commands only), then run via execFile in PROJECT_ROOT —
 * a deliberate, narrow bridge to the real repo that bypasses the /workspace
 * sandbox. Every attempt (allowed or refused) is audited to data/exec-audit.jsonl.
 */
async function runRepoTarget(
  command: string,
  timeoutMs: number,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!repoExecEnabled()) {
    auditExec({ session: sessionId, command, allowed: false, reason: 'SUDO_REPO_EXEC not set' });
    return {
      success: false,
      output: 'system.exec target:"repo" is disabled. The operator must set SUDO_REPO_EXEC=1 to allow allowlisted commands against the real repo.',
      data: { repo: true, disabled: true },
    };
  }

  const match = checkRepoCommand(command);
  if (!match.allowed) {
    auditExec({ session: sessionId, command, allowed: false, reason: match.reason });
    return {
      success: false,
      output: `Refused: ${match.reason}. target:"repo" allows only read/verify commands (pnpm/npm test|lint|build, read-only git, rg, ls, wc, cat, head, tail, stat, sort, uniq, read-only pm2; pipes between them are OK; credential paths are always blocked).`,
      data: { repo: true, refused: true, reason: match.reason },
    };
  }

  const start = Date.now();
  logger.info({ session: sessionId, argv: match.argv, segments: match.pipeline?.length ?? 1 }, 'system.exec repo-target: running allowlisted command');
  const { stdout, stderr, exitCode } = await runRepoPipeline(match.pipeline ?? [match.argv], timeoutMs, signal);
  const durationMs = Date.now() - start;
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  const { text: output, truncated } = truncate(combined || '(no output)');
  const success = exitCode === 0;

  auditExec({ session: sessionId, command, allowed: true, exitCode });
  logger.info({ session: sessionId, exitCode, durationMs, truncated, repo: true }, 'Repo-target command completed');

  return {
    success,
    output: success ? output : `Command exited with code ${exitCode}:\n${output}`,
    data: { exitCode, durationMs, truncated, repo: true },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const execTool: ToolDefinition = {
  name: 'system.exec',
  description:
    'Execute any shell command and return stdout/stderr. Use for running scripts, ' +
    'installing packages, compiling code, or any operation not covered by other tools. ' +
    'Supports pipes, redirects, and all bash features. Non-allowlisted commands require ' +
    'human approval (set EXEC_APPROVAL_MODE=off to disable the gate). ' +
    'WRITE-AND-RUN CODE HERE: the sandbox /workspace is writable and PERSISTS across exec ' +
    "calls within a session — author runnable code directly in it (e.g. `cat > app.py <<'EOF' " +
    "… EOF`, or `mkdir -p pkg && cat > pkg/mod.py <<'EOF' … EOF` for multi-file projects) and " +
    'run it in the same sandbox; files are reachable at /workspace/… and at their real host ' +
    'path. Do NOT use coder.write-file / meta.self-modify for throwaway runnable code — those ' +
    'write to the REAL repo which the sandbox cannot see; reserve them for actual repo edits. ' +
    'Set target:"repo" to run an allowlisted read/verify command (pnpm/npm test|lint|build, ' +
    'read-only git, rg, cat/head/tail/stat, pipes between read-only commands) against the REAL ' +
    'repo instead of the sandbox — gated by SUDO_REPO_EXEC. Absolute paths under the repo root ' +
    'are auto-rewritten to repo-relative; credential files are always refused.',
  category: 'system',
  requiresConfirmation: true,
  // Raised from 120s: target:"repo" build/test runs legitimately take minutes.
  timeout: 300_000,
  parameters: {
    command: {
      type: 'string',
      required: true,
      description: 'Shell command to execute (run via /bin/bash -c; for target:"repo", an allowlisted argv with no shell metacharacters).',
    },
    cwd: {
      type: 'string',
      required: false,
      description: 'Working directory for the command. Defaults to the session working directory. Ignored when target:"repo" (always runs in the repo root).',
    },
    target: {
      type: 'string',
      required: false,
      description: 'Where to run. "sandbox" (default) is isolated in /workspace and CANNOT see the real repo, DBs, or logs. "repo" runs against the REAL project (allowlisted read/verify commands only — plain, no shell metacharacters): use it for tests, lint, git, rg, `pm2 logs sudo-ai-v5`, and reading data/* files. If a sandbox command returns empty when you expected real output, you needed target:"repo".',
      enum: ['sandbox', 'repo'],
    },
    timeout: {
      type: 'number',
      required: false,
      description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT}).`,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = params['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        success: false,
        output: 'system.exec: "command" parameter is required and must be a non-empty string.',
        data: {},
      };
    }

    // In sandboxed mode, cwd param from agent is ignored — bwrap always uses
    // /workspace as the effective cwd (enforced by --chdir /workspace).
    // In unsandboxed mode, honour any cwd param the agent provides.
    const cwd =
      typeof params['cwd'] === 'string' && params['cwd'].trim() !== ''
        ? params['cwd'].trim()
        : ctx.workingDir;

    const timeoutMs =
      typeof params['timeout'] === 'number' && params['timeout'] > 0
        ? params['timeout']
        : DEFAULT_TIMEOUT;

    // target:"repo" — allowlisted read/verify command against the real repo,
    // outside the sandbox. Self-gating (SUDO_REPO_EXEC + allowlist), so it never
    // touches the EXEC_APPROVAL_MODE / sandbox flow below. Default to a longer
    // window since build/test runs take minutes (capped at the tool timeout).
    if (params['target'] === 'repo') {
      const repoTimeout =
        typeof params['timeout'] === 'number' && params['timeout'] > 0
          ? Math.min(params['timeout'], 300_000)
          : 240_000; // a full `pnpm test` runs ~2.5min; 180s would clip it into a timeout
      return runRepoTarget(command, repoTimeout, ctx.sessionId, ctx.signal);
    }

    // Security: workspaceDir must always be system-controlled (provisioned by SandboxManager).
    // Fall back to ctx.workingDir (also system-set), never to agent-supplied params.cwd.
    // This prevents an attacker from bind-mounting an arbitrary host path into the sandbox.
    return executeWithGate({
      command,
      cwd,
      timeoutMs,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      sandboxPolicy: ctx.sandboxPolicy,
      workspaceDir: ctx.workspaceDir ?? ctx.workingDir,
      // Owner attribution comes from the channel adapter's authenticated peer
      // check — never from anything the model can set.
      ownerVerified: ctx.isOwner === true,
    });
  },
};
