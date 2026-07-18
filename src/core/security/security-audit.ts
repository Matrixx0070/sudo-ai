/**
 * @file security/security-audit.ts — GW-7
 *
 * The pure core of `sudo-ai security-audit`. A catalog of checks, each producing
 * findings whose severity is computed from CONTEXT (tool blast radius × inbound
 * exposure), not a fixed table. Reuses the single sources of truth from Wave 1:
 *   - posture registry (collectWeakeningFlags) for the weakening-flag checks,
 *   - the GW-10 CONTRADICTIONS table + ghost-flag lint (flag-lint.ts).
 *
 * Everything here is pure + dependency-injected (env, fileExists, fileMode) so
 * each check is unit-testable and the CLI wrapper (cli/commands/security-audit)
 * only supplies real filesystem probes. Narrow `--fix` remediations (file-perm
 * tightening only) live in the CLI wrapper; this module classifies + advises.
 */

import { collectWeakeningFlags } from './posture.js';
import {
  CONTRADICTIONS,
  isContradictionOverride,
  untrustedInboundActive,
  type LintDeps,
} from '../config/flag-lint.js';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export interface AuditFinding {
  /** Stable check id, e.g. `posture.SUDO_SANDBOX_DISABLE`. */
  id: string;
  severity: Severity;
  /** What was observed. */
  evidence: string;
  /** Exact remediation command / guidance (never auto-applied unless fixable). */
  remediation: string;
  /** True when a narrow, reversible auto-fix exists (file-perm tightening only). */
  fixable?: boolean;
  /** For fixable findings: the file whose permissions to tighten. */
  fixPath?: string;
}

export interface AuditDeps {
  env: NodeJS.ProcessEnv;
  /** Committed SUDO_* manifest (the names code reads). */
  manifest: readonly string[];
  fileExists: (p: string) => boolean;
  /** POSIX permission bits for a path, or null when missing. */
  fileMode: (p: string) => number | null;
}

export interface AuditResult {
  findings: AuditFinding[];
  /** 0 = clean; 1 = any HIGH; 2 = any CRITICAL (CI-friendly). */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
}

function isLoopbackHost(h: string | undefined): boolean {
  if (!h) return true;
  const v = h.trim().toLowerCase();
  return v === '' || v === '127.0.0.1' || v === '::1' || v === 'localhost';
}

/** True when a configured bind exposes the gateway beyond loopback. */
function nonLoopbackExposure(env: NodeJS.ProcessEnv): boolean {
  for (const key of ['SUDO_GATEWAY_BIND', 'SUDO_DASHBOARD_BIND', 'WEB_CHAT_BIND', 'BIND_ADDRESS']) {
    if (!isLoopbackHost(env[key])) return true;
  }
  return false;
}

/** GW-1 semantics: is a global daily USD LLM budget configured? */
function budgetEnforced(env: NodeJS.ProcessEnv): boolean {
  for (const key of ['SUDO_DAILY_LLM_BUDGET_USD', 'SUDO_LLM_GLOBAL_BUDGET_USD']) {
    const raw = env[key];
    if (raw === undefined) continue;
    const t = raw.trim().toLowerCase();
    if (t === '' || t === 'off') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return true;
  }
  return false;
}

/**
 * Contextual severity for a posture weakening flag. The one genuinely
 * context-sensitive rule (per spec): SUDO_SANDBOX_DISABLE is CRITICAL when any
 * untrusted inbound channel can reach the unsandboxed executor, else MEDIUM.
 */
function postureSeverity(flag: string, env: NodeJS.ProcessEnv): Severity {
  if (flag === 'SUDO_SANDBOX_DISABLE') {
    return untrustedInboundActive(env).length > 0 ? 'CRITICAL' : 'MEDIUM';
  }
  if (flag === 'SUDO_GATEWAY_UNIFIED_AUTH') {
    return nonLoopbackExposure(env) ? 'HIGH' : 'MEDIUM';
  }
  const high = new Set([
    'SUDO_TENANCY_ALLOW_UNSAFE',
    'SUDO_SELFBUILD_ALLOW_PROTECTED',
    'SUDO_MCP_ALLOW_PRIVATE_HOSTS',
    'SUDO_ADMIN_API_DANGER',
    'SUDO_ALLOW_CONTRADICTORY_CONFIG',
    'SUDO_SECURITY_STRICT',
    'SUDO_KAIROS',
  ]);
  return high.has(flag) ? 'HIGH' : 'MEDIUM';
}

/** Raw prod credentials that have a SecretRef (`_REF`) migration seam. */
const CRED_ENV_WITH_REF = [
  'GATEWAY_TOKEN',
  'GATEWAY_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'WEB_CHAT_TOKEN',
] as const;

/** Files that must be owner-only (0600). Checked for group/other readability. */
export const SENSITIVE_FILES = [
  'data/xai-oauth.json',
  'data/oauth-creds.json',
  'data/gateway.db',
  '.env',
] as const;

// ---------------------------------------------------------------------------
// Check catalog
// ---------------------------------------------------------------------------

export function runAuditChecks(deps: AuditDeps): AuditResult {
  const { env, manifest, fileExists, fileMode } = deps;
  const findings: AuditFinding[] = [];

  // posture.* — one per ACTIVE weakening flag, contextual severity.
  for (const w of collectWeakeningFlags(env)) {
    findings.push({
      id: `posture.${w.flag}`,
      severity: postureSeverity(w.flag, env),
      evidence: `${w.flag} active — ${w.effect}`,
      remediation: w.flag === 'SUDO_SANDBOX_DISABLE'
        ? 'unset SUDO_SANDBOX_DISABLE (or set to 0) to restore the sandbox'
        : `review ${w.flag}; unset it unless the weakening is deliberate`,
    });
  }

  // flags.ghost — SUDO_* env names no code reads.
  const known = new Set(manifest);
  for (const k of Object.keys(env).filter((n) => /^SUDO_[A-Z0-9_]+$/.test(n) && !known.has(n)).sort()) {
    findings.push({
      id: `flags.ghost.${k}`,
      severity: 'LOW',
      evidence: `${k} is set but no code reads it (ghost flag)`,
      remediation: `remove ${k} from the environment, or add the reader in src/ and regenerate the manifest`,
    });
  }

  // flags.contradiction — known-bad combos (shared GW-10 table).
  const lintDeps: Required<LintDeps> = { fileExists };
  for (const c of CONTRADICTIONS) {
    const detail = c.test(env, lintDeps);
    if (detail) {
      findings.push({
        id: `flags.contradiction.${c.id}`,
        severity: 'HIGH',
        evidence: detail + (isContradictionOverride(env) ? ' [boot allowed by SUDO_ALLOW_CONTRADICTORY_CONFIG=1]' : ''),
        remediation: 'resolve the contradictory flags; do not rely on SUDO_ALLOW_CONTRADICTORY_CONFIG=1',
      });
    }
  }

  // secrets.env-not-ref — raw prod creds where a _REF seam exists.
  if (env['SUDO_SECRETS_REF'] !== '0') {
    for (const name of CRED_ENV_WITH_REF) {
      if (truthy(env[name]) && !truthy(env[`${name}_REF`])) {
        findings.push({
          id: `secrets.env-not-ref.${name}`,
          severity: 'MEDIUM',
          evidence: `${name} is set as a raw env value while a SecretRef seam (${name}_REF) exists`,
          remediation: `migrate ${name} to a file SecretRef: set ${name}_REF={"source":"file","id":"data/secrets/${name.toLowerCase()}"}`,
        });
      }
    }
  }

  // net.listeners — extra listening ports beyond the canonical 18900 (+18910
  // until GW-4 retires the dashboard port). Derived from config, not an OS scan.
  const dashPort = env['SUDO_DASHBOARD_PORT'];
  if (dashPort && dashPort !== '0' && dashPort !== '18910') {
    findings.push({
      id: 'net.listeners.dashboard-port',
      severity: 'LOW',
      evidence: `SUDO_DASHBOARD_PORT=${dashPort} opens a second listener beyond the canonical gateway port 18900`,
      remediation: 'set SUDO_GATEWAY_UI_ON_MAIN=1 and drop SUDO_DASHBOARD_PORT (GW-4)',
    });
  }

  // auth.unset — no GATEWAY_TOKEN while exposed beyond loopback.
  if (!truthy(env['GATEWAY_TOKEN']) && !truthy(env['GATEWAY_SECRET']) && nonLoopbackExposure(env)) {
    findings.push({
      id: 'auth.unset',
      severity: 'HIGH',
      evidence: 'no GATEWAY_TOKEN/GATEWAY_SECRET configured while a non-loopback bind is set — the gateway is reachable without auth',
      remediation: 'set GATEWAY_TOKEN (and rotate it) before binding beyond loopback',
    });
  }

  // budget.off — GW-1 caps off → HIGH (invariant #10).
  if (!budgetEnforced(env)) {
    findings.push({
      id: 'budget.off',
      severity: 'HIGH',
      evidence: 'daily LLM USD budget enforcement is OFF (SUDO_DAILY_LLM_BUDGET_USD unset/off) — background jobs can spend unbounded',
      remediation: 'set SUDO_DAILY_LLM_BUDGET_USD to a positive daily cap',
    });
  }

  // fs.perms — sensitive files readable by group/other.
  for (const rel of SENSITIVE_FILES) {
    if (!fileExists(rel)) continue;
    const mode = fileMode(rel);
    if (mode === null) continue;
    if ((mode & 0o077) !== 0) {
      findings.push({
        id: `fs.perms.${rel}`,
        severity: 'MEDIUM',
        evidence: `${rel} is group/other-accessible (mode ${(mode & 0o777).toString(8).padStart(3, '0')})`,
        remediation: `chmod 600 ${rel}`,
        fixable: true,
        fixPath: rel,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id));

  const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
  const hasHigh = findings.some((f) => f.severity === 'HIGH');
  const exitCode = hasCritical ? 2 : hasHigh ? 1 : 0;
  return { findings, exitCode };
}

/** The fixable subset (file-perm tightening) — the ONLY direct auto-fix allowed. */
export function fixableFindings(result: AuditResult): AuditFinding[] {
  return result.findings.filter((f) => f.fixable && f.fixPath);
}
