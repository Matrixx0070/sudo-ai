/**
 * debug-share.ts
 *
 * `GET /api/admin/debug-share` snapshot composer (gap #28b slice 3 —
 * Hermes-parity admin powers; mirrors `web_server.py:1180` /api/ops/debug-share).
 *
 * The endpoint returns a single JSON blob an operator can paste into a
 * bug report or upload manually. The Hermes equivalent posts to a remote
 * paste service; sudo-ai's slice 3 stays pull-only — the operator pipes
 * the output to wherever they want it. Less convenient, but it never
 * touches an unauthenticated third-party endpoint.
 *
 * Redaction rules (RFC: defense-in-depth, not authoritative — also reflected
 * in operator docs that say "don't share this if you don't trust the
 * recipient with operator-level access"):
 *
 *   - **Allowlist of env vars** safe to surface verbatim (bind, port flags,
 *     non-sensitive feature toggles, etc.).
 *   - **Denylist by key-name regex** (`/TOKEN|SECRET|KEY|PASSWORD|PASS|
 *     AUTH|CRED|PRIVATE|JWT/i`) — anything matching is replaced with
 *     `<redacted>`.
 *   - **Unknown env vars** are NOT included at all — opt-in by allowlist
 *     keeps the snapshot deterministic and avoids leaking operator-set
 *     vars we never anticipated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Sensitivity regex applied to env keys + nested object keys (case-insensitive). */
const SENSITIVE_KEY_REGEX = /TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|CRED|PRIVATE|JWT/i;

/**
 * Allowlist of env vars surfaced verbatim. Any var matching the sensitive
 * regex is still redacted regardless of allowlist (defense in depth — an
 * operator who adds a new `*_TOKEN` to this list by accident gets
 * redaction anyway).
 */
const ENV_ALLOWLIST: readonly string[] = [
  'NODE_ENV',
  'PWD',
  'HOME',
  'USER',
  'HOSTNAME',
  // Bind / port config (non-secret operator intent).
  'SUDO_DASHBOARD_PORT',
  'SUDO_DASHBOARD_BIND',
  'SUDO_DASHBOARD_INSECURE',
  'SUDO_DASHBOARD_DISABLE',
  'SUDO_DASHBOARD_HOSTS',
  // Feature flags (no secret material; operator wants these visible).
  'SUDO_ADMIN_POWERS',
  'SUDO_DASHBOARD_LOG_RING_DISABLE',
  'SUDO_PLUGINS',
  'SUDO_MSG_COALESCE',
  'SUDO_GROUP_MENTION_ONLY',
  'SUDO_USER_HOOKS',
  'SUDO_CHAT_APPROVALS',
  'SUDO_FORK_CONTEXT',
  'SUDO_CHANNEL_COMMANDS',
  'SUDO_SKILLS_DIRS',
  'SUDO_AUTONOMY_V1',
  'SUDO_SELF_BUILD_MODE',
  'SUDO_TOOL_CONCURRENCY',
  'SUDO_PARALLEL_TOOLS_DISABLE',
  'SUDO_CROSS_CONTROL_DISABLE',
  'SUDO_EXEC_BACKEND',
  'SUDO_SANDBOX_DISABLE',
  'SUDO_VAULT_MASTER_KEY_PRESENT', // sentinel only; raw key never surfaces
  // Misc operator-config (non-secret).
  'PM2_USAGE',
  'pm_id',
  'name',
];

/**
 * Read package.json once at module load — cheap, doesn't change at runtime.
 * Path is resolved MODULE-RELATIVE via `import.meta.url` (not CWD-relative)
 * so an operator who changes `process.cwd()` between import and first call
 * still gets the right version. Dist layout: `dist/core/dashboard/debug-
 * share.js` → three `..` up reaches the project root.
 */
let cachedPkgVersion: string | undefined;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
function readPkgVersion(): string {
  if (cachedPkgVersion !== undefined) return cachedPkgVersion;
  try {
    const pkgPath = path.resolve(MODULE_DIR, '..', '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    cachedPkgVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedPkgVersion = 'unknown';
  }
  return cachedPkgVersion;
}

/** Test-only: clear the cached version so a follow-up call re-reads disk. */
export function _resetPkgVersionCache(): void {
  cachedPkgVersion = undefined;
}

/**
 * Redact a single env value by KEY policy. Returns `<redacted>` for
 * sensitive keys; the original value otherwise. Unset vars are returned
 * as `undefined` so the caller can omit them.
 */
function redactEnvValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (SENSITIVE_KEY_REGEX.test(key)) return '<redacted>';
  return value;
}

/**
 * Build the allowlisted env snapshot. Vars not in the allowlist are
 * omitted entirely. The `*_PRESENT` sentinel for the master key is
 * computed here (true iff `SUDO_VAULT_MASTER_KEY` is non-empty) so the
 * operator can confirm vault is configured without leaking the key.
 */
function snapshotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (key === 'SUDO_VAULT_MASTER_KEY_PRESENT') {
      const masterKey = process.env['SUDO_VAULT_MASTER_KEY'];
      out[key] = typeof masterKey === 'string' && masterKey.length > 0 ? 'true' : 'false';
      continue;
    }
    const v = redactEnvValue(key, process.env[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Recursively walk an arbitrary object and replace string values at any
 * key matching the sensitive regex with `<redacted>`. Arrays + primitives
 * pass through. Cycles are broken with a WeakSet. Max depth 6 (snapshot
 * structures are shallow; deeper is almost certainly a bug or a runtime
 * graph we shouldn't be including).
 */
export function redactDeep(input: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > 6) return '<max-depth>';
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (seen.has(input as object)) return '<cycle>';
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((v) => redactDeep(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      out[k] = '<redacted>';
    } else {
      out[k] = redactDeep(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Optional sources the snapshot pulls from. Each is a typed read shape so
 * the composer stays decoupled from `DashboardServer`. Anything not
 * supplied is honestly omitted with a "not_registered" sentinel.
 */
export interface DebugShareSources {
  stats?: () => unknown;
  health?: () => unknown;
  alignment?: () => unknown;
  recentActivity?: (limit: number) => unknown;
  currentModel?: () => string | undefined;
  liveAgents?: () => unknown;
  bind?: () => string;
  loopbackTrust?: () => boolean;
  hostAllowlist?: () => readonly string[];
  adminPowers?: () => boolean;
}

/** Composed snapshot. */
export interface DebugShareSnapshot {
  generatedAt: string;
  process: {
    pid: number;
    node: string;
    platform: string;
    arch: string;
    pkgVersion: string;
    uptimeSeconds: number;
  };
  dashboard: {
    bind?: string;
    loopbackTrust?: boolean;
    hostAllowlist?: readonly string[];
    adminPowers?: boolean;
  };
  model: string | 'not_registered';
  stats?: unknown;
  health?: unknown;
  alignment?: unknown;
  recentActivity?: unknown;
  liveAgents?: unknown;
  env: Record<string, string>;
}

/** Build the snapshot. All callers go through this — no other entry point. */
export function buildDebugShareSnapshot(sources: DebugShareSources): DebugShareSnapshot {
  // Helper that wraps a source callback in a try/catch so a thrown subsystem
  // never breaks the whole snapshot. Failed lookups surface as a structured
  // error string instead of being silently dropped — operators need to know
  // when a piece of state was inaccessible at snapshot time.
  const safe = <T,>(fn: (() => T) | undefined): T | { _error: string } | undefined => {
    if (!fn) return undefined;
    try { return fn(); }
    catch (err: unknown) { return { _error: err instanceof Error ? err.message : String(err) }; }
  };

  const stats = safe(sources.stats);
  const health = safe(sources.health);
  const alignment = safe(sources.alignment);
  const recentActivity = sources.recentActivity ? safe(() => sources.recentActivity!(20)) : undefined;
  const liveAgents = safe(sources.liveAgents);
  const bind = safe(sources.bind);
  const loopbackTrust = safe(sources.loopbackTrust);
  const hostAllowlist = safe(sources.hostAllowlist);
  const adminPowers = safe(sources.adminPowers);
  const currentModel = safe(sources.currentModel);

  const snapshot: DebugShareSnapshot = {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pkgVersion: readPkgVersion(),
      uptimeSeconds: Math.floor(process.uptime()),
    },
    dashboard: {
      ...(typeof bind === 'string' ? { bind } : {}),
      ...(typeof loopbackTrust === 'boolean' ? { loopbackTrust } : {}),
      ...(Array.isArray(hostAllowlist) ? { hostAllowlist } : {}),
      ...(typeof adminPowers === 'boolean' ? { adminPowers } : {}),
    },
    model: typeof currentModel === 'string' && currentModel.length > 0 ? currentModel : 'not_registered',
    env: snapshotEnv(),
  };
  if (stats !== undefined) snapshot.stats = redactDeep(stats);
  if (health !== undefined) snapshot.health = redactDeep(health);
  if (alignment !== undefined) snapshot.alignment = redactDeep(alignment);
  if (recentActivity !== undefined) snapshot.recentActivity = redactDeep(recentActivity);
  if (liveAgents !== undefined) snapshot.liveAgents = redactDeep(liveAgents);
  return snapshot;
}

/** Exposed for tests that want to assert the redaction regex. */
export const _SENSITIVE_KEY_REGEX = SENSITIVE_KEY_REGEX;
export const _ENV_ALLOWLIST = ENV_ALLOWLIST;
