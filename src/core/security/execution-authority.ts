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
import { isDangerousCommand } from '../agent/exec-policy.js';

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

  // Containment (never a prompt): the hardened DANGEROUS_PREFIXES force-deny
  // keeps its power in autonomous mode. An adversarial review found that
  // short-circuiting before it silently replaced ~20 audited entries with the
  // handful of patterns below — a capability regression, not a simplification.
  // Both containment layers analyse the SAME normalised strings, or a wrapper
  // like `bash -c "..."` / `${HOME}` hides intent from one of them. Every
  // expansion variant is checked, so `${HOME:-/}` is refused either way.
  const variants = req.command !== undefined ? analysisVariants(req.command) : [];
  const refused =
    variants.some((v) => isDangerousCommand(req.action, { command: v })) ||
    variants.some((v) => isCatastrophicCommand(v));

  if (req.command && refused && !catastrophicRefusalLifted()) {
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
 * Whole-system destruction detection — a last-resort backstop against an
 * UNRECOVERABLE mistake, not a policy engine.
 *
 * Implemented as a small parser rather than a literal-prefix list because an
 * adversarial review (2026-08-16) defeated the first regex-only version with
 * fifteen realistic variants: `/dev/nvme0n1` (the primary disk on most modern
 * servers), partition suffixes (`/dev/sda1`), quoted root (`rm -rf "/"`),
 * separated flags (`rm -r -f /`), `--no-preserve-root`, `wipefs`, `shred`,
 * `find / -delete`, and `cd / && rm -rf *`.
 *
 * `isDangerousCommand()` (exec-policy's hardened DANGEROUS_PREFIXES) runs
 * alongside this in `authorize()` — that list keeps its force-deny power in
 * autonomous mode instead of being silently replaced by this one.
 */

/** Whole-disk / partition device nodes. Destroying one is unrecoverable. */
const BLOCK_DEVICE =
  /\/dev\/(sd[a-z]\d*|nvme\d+n\d+(p\d+)?|vd[a-z]\d*|hd[a-z]\d*|xvd[a-z]\d*|mmcblk\d+(p\d+)?|disk\d+)\b/;

/**
 * Top-level directories whose deletion destroys the system or the owner's
 * work. Their SUBPATHS stay freely deletable — `rm -rf /var/log/myapp` and
 * `rm -rf /root/sudo-ai-v4/dist` are ordinary sysadmin work and must run.
 */
const PROTECTED_ROOTS = new Set([
  '/', '//', '/.', '/*', '/bin', '/boot', '/dev', '/etc', '/home', '/lib',
  '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys',
  '/usr', '/var',
]);

/** Remove quoting so `rm -rf "/"` and `rm -rf '/'` normalise to `rm -rf /`. */
function unquote(token: string): string {
  return token.replace(/['"]/g, '');
}

/** Split a compound command on shell separators into individual commands. */
function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;\n|])/).map((s) => s.trim()).filter(Boolean);
}

/** True when an `rm` invocation is both recursive and forced, any flag form. */
function rmIsRecursiveForce(tokens: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const raw of tokens.slice(1)) {
    const t = unquote(raw);
    if (!t.startsWith('-')) continue;
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (/[rR]/.test(t)) recursive = true;
      if (/f/.test(t)) force = true;
    }
  }
  return recursive && force;
}

/** Non-flag arguments of a command, unquoted. */
function operandsOf(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .map(unquote)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

/** Normalise a path operand for protected-root comparison. */
function normalisePath(p: string): string {
  // Always fully normalise: runs of slashes (`//////`), `.` segments and
  // trailing slashes (`/etc//`) all previously defeated the protected-root
  // comparison (adversarial review round 3).
  if (!p.startsWith('/')) return p;
  const resolved = resolveDots(p);
  return resolved === '' ? '/' : resolved;
}

/**
 * Normalise a command before analysis so trivial wrappers and expansions
 * cannot hide intent (adversarial review 2026-08-16 defeated the first parser
 * with `bash -c "rm -rf /"`, `${HOME}`, `` `echo /` ``, and `/etc/../`).
 *
 * Static analysis can never resolve every runtime expansion — `rm -rf $(pwd)`
 * depends on the working directory. This is a best-effort backstop layered
 * under the bwrap sandbox, not a security boundary; it closes the cheap,
 * obvious evasions of the audited bans.
 */
export function normalizeForAnalysis(command: string): string {
  let out = command.trim();

  // Neutral prefixes add nothing to the analysis. Applied repeatedly so
  // `sudo env nohup rm -rf /` collapses all the way down.
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(/^(sudo|doas|env|nohup|stdbuf|command|ionice|nice)\s+(-{1,2}[A-Za-z][\w-]*(=\S+)?\s+)*/, '');
    out = out.replace(/^timeout\s+(-{1,2}\S+\s+)*[\d.]+[smhd]?\s+/, '');
    if (out === before) break;
  }

  // Unwrap `bash -c "..."` / `sh -c '...'` (two levels is plenty).
  for (let i = 0; i < 2; i++) {
    const m = /^(?:\/bin\/)?(?:ba|z|k)?sh\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(out.trim());
    if (!m || m[2] === undefined) break;
    out = m[2].trim();
  }

  // `${VAR}` → `$VAR` so the audited `$HOME` ban applies to both spellings.
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');

  // Resolve trivially-static substitutions: `$(echo X)`, `` `echo X` ``,
  // `$(printf X)`, `$(printf '%s' X)`.
  out = out.replace(/\$\(\s*echo\s+([^)]*)\)/g, '$1');
  out = out.replace(/`\s*echo\s+([^`]*)`/g, '$1');
  out = out.replace(/\$\(\s*printf\s+(?:'%s'|"%s"|%s)?\s*([^)]*)\)/g, '$1');
  out = out.replace(/`\s*printf\s+(?:'%s'|"%s"|%s)?\s*([^`]*)`/g, '$1');

  return out.trim();
}

/**
 * A `${VAR:-default}` can expand to either branch and static analysis cannot
 * know which. Return BOTH readings so a catastrophic one is never missed:
 * `rm -rf ${HOME:-/}` must be refused whether HOME is set or not.
 */
export function analysisVariants(command: string): string[] {
  const BRACE_DEFAULT = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=+])([^}]*)\}/g;
  const asVar = command.replace(BRACE_DEFAULT, '$$$1');
  const asDefault = command.replace(BRACE_DEFAULT, '$2');
  const out = [normalizeForAnalysis(asVar)];
  if (asDefault !== asVar) out.push(normalizeForAnalysis(asDefault));
  return out;
}

/** Collapse `.` and `..` segments so `/etc/../` resolves to `/`. */
function resolveDots(p: string): string {
  if (!p.startsWith('/')) return p;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * True when the command would destroy the whole system or a raw disk.
 *
 * Deliberately narrow on the permissive side: ordinary destructive sysadmin
 * work (`rm -rf /tmp/build`, `rm -rf node_modules`, `mkfs.ext4 /tmp/loopfile`,
 * `dd of=/tmp/img`) must keep running without asking — that is the directive.
 */
export function isCatastrophicCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  const normalised = normalizeForAnalysis(command);

  const segments = splitSegments(normalised);
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i] ?? '';
    let tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    let head = unquote(tokens[0] ?? '');

    // `echo / | xargs rm -rf` — the destructive operand arrives over the pipe.
    // Rebuild the effective command from the producing segment.
    if (head === 'xargs') {
      // Drop only xargs' OWN leading flags (-n1, -0, -I{}); everything from
      // the command name onward keeps its flags — `rm -rf` must stay `rm -rf`.
      const rest = tokens.slice(1);
      let k = 0;
      while (k < rest.length && /^-/.test(unquote(rest[k] ?? ''))) k++;
      const inner = rest.slice(k);
      const prevTokens = (segments[i - 1] ?? '').split(/\s+/).filter(Boolean);
      const piped = unquote(prevTokens[0] ?? '') === 'echo' ? prevTokens.slice(1) : [];
      tokens = [...inner, ...piped];
      segment = tokens.join(' ');
      head = unquote(tokens[0] ?? '');
      if (tokens.length === 0) continue;
    }

    // Raw-device writes: dd of=/dev/sda, > /dev/nvme0n1, mkfs, wipefs, shred.
    if (BLOCK_DEVICE.test(segment)) {
      if (/^(dd|mkfs(\.[a-z0-9]+)?|wipefs|shred|badblocks|parted|sgdisk|fdisk)$/.test(head)) return true;
      if (/>\s*['"]?\/dev\//.test(segment)) return true;
    }

    if (head === 'rm' && rmIsRecursiveForce(tokens)) {
      for (const operand of operandsOf(tokens)) {
        if (PROTECTED_ROOTS.has(normalisePath(operand))) return true;
        // `rm -rf *` is catastrophic only when the shell was moved to / first.
        if ((operand === '*' || operand === './*') && cwdIsRoot(normalised, segment)) return true;
      }
    }

    // `chmod -R <any> /` / `chown -R <any> /` — bricks the system just as
    // thoroughly as deleting it (the audited list only covered mode 777).
    if ((head === 'chmod' || head === 'chown') && tokens.some((t) => /^-[a-zA-Z]*R/.test(unquote(t)))) {
      const paths = operandsOf(tokens).filter((t) => t.startsWith('/'));
      if (paths.some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }

    // Moving a protected root away is equivalent to deleting it.
    if (head === 'mv') {
      const paths = operandsOf(tokens);
      if (paths.length > 1 && paths.slice(0, -1).some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }

    // `find / -delete` / `find / -exec rm -rf {}` — a slower `rm -rf /`.
    if (head === 'find') {
      const targets = operandsOf(tokens).filter((t) => t.startsWith('/'));
      const deletes = /\s-delete\b/.test(segment) || /-exec\s+rm\b/.test(segment);
      if (deletes && targets.some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }
  }

  return false;
}

/** True when an earlier segment of the same command line cd'd to `/`. */
function cwdIsRoot(fullCommand: string, currentSegment: string): boolean {
  for (const segment of splitSegments(fullCommand)) {
    if (segment === currentSegment) break;
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (unquote(tokens[0] ?? '') === 'cd') {
      const target = operandsOf(tokens)[0];
      if (target !== undefined && normalisePath(target) === '/') return true;
    }
  }
  return false;
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
