/**
 * Execution Authority — the SINGLE source of truth for "may this action run
 * without asking the human first?".
 *
 * ## Why this module exists
 *
 * Owner directive (Frank, 2026-08-16): sudo-ai operates with full root-level
 * authority and executes a requested objective end to end. No approval
 * prompts, no "Are you sure?", no interruption that requires the operator to
 * authorize an individual action. That must be ONE deliberate architecture,
 * not a scatter of per-command bypasses.
 *
 * Before this module the answer was computed independently in three places
 * that did not agree (measured 2026-08-16, X6 probes):
 *
 *   1. `PermissionManager.check()` — honoured `SUDO_AUTO_APPROVE=1`.
 *   2. `system.exec` / `bg-shell` — honoured `EXEC_APPROVAL_MODE` only, and
 *      read it into a module-level const at import time, so it could not be
 *      changed without a process restart.
 *   3. Orchestration graph gates — honoured neither; parked forever unless an
 *      operator decided, even in full-auto.
 *
 * A tool marked `requiresConfirmation: true` (system.ssh) therefore executed
 * with no prompt, while a strict-mode shell command would have blocked for 5
 * minutes — opposite behaviours from the same intent. Centralising removes
 * that class of drift: every surface now asks THIS module.
 *
 * ## What autonomy does and does not mean
 *
 * Autonomous mode removes *interaction*, not *containment*. Two things are
 * deliberately NOT prompts and therefore still apply:
 *
 *   - the bwrap sandbox policy on `system.exec` (a mount namespace, not a
 *     question), and
 *   - `DANGEROUS_PREFIXES` (`rm -rf /` and friends), which are refused
 *     outright and were never a prompt either.
 *
 * Both are working capabilities; per the engineering doctrine they are not
 * dropped to satisfy a request about prompts. `SUDO_AUTHORITY_ALLOW_CATASTROPHIC=1`
 * exists so the owner can lift the catastrophic-command refusal explicitly,
 * as a deliberate act, without editing code.
 *
 * ## Modes
 *
 *   - `autonomous` (DEFAULT): nothing ever prompts. Every surface executes.
 *   - `gated`: restores human-in-the-loop prompting on every surface.
 *
 * Resolution order (first match wins):
 *   1. `SUDO_AUTHORITY_MODE=autonomous|gated` — the explicit, current knob.
 *   2. `SUDO_AUTO_APPROVE=0` → gated (legacy opt-out kept working).
 *   3. default → autonomous.
 *
 * Evaluated per call, never cached in a module const, so a live config change
 * takes effect on the next action instead of the next restart.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security:authority');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How the agent treats human-in-the-loop confirmation, system-wide. */
export type AuthorityMode = 'autonomous' | 'gated';

/** Surfaces that can ask for authority. Used for logging/telemetry only. */
export type AuthoritySurface =
  | 'agent-tool' // agent loop tool batch (requiresConfirmation tools)
  | 'shell-exec' // system.exec
  | 'bg-shell' // background shell
  | 'graph-gate' // orchestration graph approval nodes
  | 'acp' // ACP fs/terminal tools
  | 'other';

export interface AuthorityRequest {
  /** Which surface is asking (telemetry only — never changes the answer). */
  surface: AuthoritySurface;
  /** Tool name or a short action label, e.g. 'system.ssh'. */
  action: string;
  /** Raw shell command when the surface has one. */
  command?: string;
}

export interface AuthorityDecision {
  /** True when the action may proceed immediately. */
  proceed: boolean;
  /** True when the surface must ask a human (only ever in `gated` mode). */
  requiresPrompt: boolean;
  /** Resolved mode at decision time. */
  mode: AuthorityMode;
  /** Machine-readable reason, e.g. 'autonomous', 'catastrophic-refused'. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the current authority mode. Read fresh on every call — see the
 * module docstring on why this is deliberately not a cached const.
 */
export function getAuthorityMode(): AuthorityMode {
  const explicit = (process.env['SUDO_AUTHORITY_MODE'] ?? '').trim().toLowerCase();
  if (explicit === 'gated') return 'gated';
  if (explicit === 'autonomous') return 'autonomous';

  // Legacy opt-OUT: the old knob could only turn autonomy on. An explicit
  // `SUDO_AUTO_APPROVE=0` is the only way it can now turn autonomy off, so a
  // pre-existing deployment that disabled auto-approve keeps its behaviour.
  if ((process.env['SUDO_AUTO_APPROVE'] ?? '').trim() === '0') return 'gated';

  return 'autonomous';
}

/** Convenience: true when no surface may prompt. */
export function isAutonomous(): boolean {
  return getAuthorityMode() === 'autonomous';
}

/**
 * True when catastrophic-command refusal is lifted by explicit owner opt-in.
 * Default false: the refusal is containment, not a prompt, and stays on.
 */
export function catastrophicRefusalLifted(): boolean {
  return (process.env['SUDO_AUTHORITY_ALLOW_CATASTROPHIC'] ?? '').trim() === '1';
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * The one call every surface makes before executing a privileged action.
 *
 * In `autonomous` mode this always returns `{proceed: true, requiresPrompt:
 * false}` — with the single exception of a catastrophic command while the
 * refusal is in force, which is refused WITHOUT prompting (the operator is
 * never asked; the action simply does not run).
 */
export function authorize(req: AuthorityRequest): AuthorityDecision {
  const mode = getAuthorityMode();

  if (mode === 'gated') {
    return { proceed: false, requiresPrompt: true, mode, reason: 'gated-mode' };
  }

  if (req.command && isCatastrophicCommand(req.command) && !catastrophicRefusalLifted()) {
    log.error(
      { surface: req.surface, action: req.action, command: req.command.slice(0, 200) },
      'authority: catastrophic command REFUSED (containment, not a prompt) — ' +
        'set SUDO_AUTHORITY_ALLOW_CATASTROPHIC=1 to lift',
    );
    return { proceed: false, requiresPrompt: false, mode, reason: 'catastrophic-refused' };
  }

  log.debug({ surface: req.surface, action: req.action }, 'authority: autonomous — proceeding');
  return { proceed: true, requiresPrompt: false, mode, reason: 'autonomous' };
}

// ---------------------------------------------------------------------------
// Catastrophic-command detection
// ---------------------------------------------------------------------------

/**
 * Whole-filesystem destruction patterns. Intentionally tiny and literal: this
 * is a last-resort backstop against an unrecoverable mistake, NOT a policy
 * engine. Anything broader belongs in exec-policy's DANGEROUS_PREFIXES, which
 * still runs on the surfaces that consult it.
 */
const CATASTROPHIC = [
  /\brm\s+(-[a-z]*[rR][a-z]*f|-[a-z]*f[a-z]*[rR])\s+(--no-preserve-root\s+)?\/(\s|$|\*)/,
  /\brm\s+--recursive\s+--force\s+\/(\s|$|\*)/,
  /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//,
  /\bdd\s+[^|;]*\bof=\/dev\/[sh]d[a-z]\b/,
  />\s*\/dev\/[sh]d[a-z]\b/,
] as const;

/** True when the command matches a whole-system destruction pattern. */
export function isCatastrophicCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  return CATASTROPHIC.some((re) => re.test(command));
}

// ---------------------------------------------------------------------------
// Startup disclosure
// ---------------------------------------------------------------------------

/**
 * Log the resolved posture once at boot so the operating mode is never a
 * mystery in the logs. Called from the CLI bootstrap.
 */
export function logAuthorityPosture(): void {
  const mode = getAuthorityMode();
  if (mode === 'autonomous') {
    log.info(
      {
        mode,
        prompts: 'disabled on every surface',
        containment: catastrophicRefusalLifted()
          ? 'sandbox only (catastrophic refusal LIFTED by owner)'
          : 'sandbox + catastrophic-command refusal',
      },
      'Execution authority: AUTONOMOUS — full root-level authority, no approval prompts',
    );
  } else {
    log.warn({ mode }, 'Execution authority: GATED — surfaces will prompt for confirmation');
  }
}
