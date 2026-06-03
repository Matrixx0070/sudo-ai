/**
 * @file sandbox/sandbox-policy.ts
 * @description Helpers for merging and parsing SandboxPolicy objects.
 * mergePolicy: deep merge with override winning.
 * parsePolicy: parse from raw DB JSON, dropping unknown fields.
 */

import path from 'node:path';
import { type SandboxPolicy, DEFAULT_SANDBOX_POLICY, SandboxPolicyError } from './sandbox-types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sandbox:policy');

// ---------------------------------------------------------------------------
// Bind path validation
// ---------------------------------------------------------------------------

/** Prefixes that are never allowed as extra bind mounts. */
const BIND_DENYLIST_PREFIXES: ReadonlyArray<string> = [
  '/proc',
  '/sys',
  '/etc',
  '/root',
  '/home',
  '/run',
  '/var/run',
  '/var/log',
  '/boot',
  '/dev',
  '/dev/shm',
];

/**
 * Validate an extra bind-mount path from policy.
 * Returns true if the path is safe to use as a bind mount.
 *
 * Rules:
 *   - Input is first normalized via path.posix.normalize to collapse
 *     double-slashes (e.g. //etc/passwd → /etc/passwd) and resolve
 *     dot-segments (e.g. /etc/../tmp → /tmp which is then allowed).
 *   - Must start with '/' after normalization
 *   - Must not contain any '..' segment
 *   - Must not equal '/' (root filesystem)
 *   - Must not match a deny-listed prefix
 *
 * Note: /etc/../tmp normalizes to /tmp which is an allowed path.
 * This is intentional — callers like buildBwrapArgs do a second
 * realpathSync check to catch any remaining bypass attempts.
 */
export function validateBindPath(p: string): boolean {
  // Defense-in-depth: reject NUL bytes before normalization.
  // JS strings see '/proc\x00/safe' as-is, but C-layer realpath(3) truncates
  // at NUL to '/proc', bypassing the denylist. Reject early so future callers
  // that skip the second realpathSync check cannot be exploited.
  if (p.includes('\x00')) return false;
  // FIX #1: normalize first to collapse // and dot-segments
  p = path.posix.normalize(p);
  if (!p.startsWith('/')) return false;
  if (p === '/') return false;

  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..') return false;
  }

  for (const denied of BIND_DENYLIST_PREFIXES) {
    // Match exact prefix followed by '/' or end-of-string
    if (p === denied || p.startsWith(denied + '/')) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers (shared by mergePolicy and parsePolicy)
// ---------------------------------------------------------------------------

const MAX_BIND_ENTRIES = 32;

/**
 * Normalize a bind path: collapse dot-segments and double-slashes via
 * path.posix.normalize, then strip any trailing slash (except bare '/').
 * The caller must have already validated the path before calling this.
 */
function normalizeBind(p: string): string {
  const normalized = path.posix.normalize(p);
  // Strip trailing slash unless the result is root '/'
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

// ---------------------------------------------------------------------------
// mergePolicy
// ---------------------------------------------------------------------------

/**
 * Deep merge two policies. Fields present in `override` take precedence
 * over `base`. Arrays are replaced (not concatenated).
 */
/** Check a numeric policy override is finite, positive, and within the given cap. */
function isValidNumericOverride(v: unknown, cap: number): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v > 0 &&
    v <= cap
  );
}

export function mergePolicy(
  base: SandboxPolicy,
  override: Partial<SandboxPolicy>,
): SandboxPolicy {
  return {
    enabled: override.enabled !== undefined ? override.enabled : base.enabled,
    network: override.network !== undefined ? override.network : base.network,
    // FIX #2: validate numeric overrides to reject Infinity/NaN/out-of-range before accepting
    cpuSeconds:
      isValidNumericOverride(override.cpuSeconds, 3600)
        ? override.cpuSeconds
        : base.cpuSeconds,
    memoryMB:
      isValidNumericOverride(override.memoryMB, 8192)
        ? override.memoryMB
        : base.memoryMB,
    maxFileMB:
      isValidNumericOverride(override.maxFileMB, 1024)
        ? override.maxFileMB
        : base.maxFileMB,
    // FIX ITEM 2: validate + normalize override bind paths BEFORE slicing to 32.
    // Filtering after slicing would let an attacker pad 32 denylist entries to
    // push all valid paths past the window. Base binds are trusted (pre-validated).
    extraReadOnlyBinds:
      override.extraReadOnlyBinds !== undefined
        ? override.extraReadOnlyBinds
            .filter(validateBindPath)
            .map(normalizeBind)
            .slice(0, MAX_BIND_ENTRIES)
        : base.extraReadOnlyBinds
        ? [...base.extraReadOnlyBinds].slice(0, MAX_BIND_ENTRIES)
        : undefined,
    extraWritableBinds:
      override.extraWritableBinds !== undefined
        ? override.extraWritableBinds
            .filter(validateBindPath)
            .map(normalizeBind)
            .slice(0, MAX_BIND_ENTRIES)
        : base.extraWritableBinds
        ? [...base.extraWritableBinds].slice(0, MAX_BIND_ENTRIES)
        : undefined,
    allowedEnvVars:
      override.allowedEnvVars !== undefined
        ? [...override.allowedEnvVars].slice(0, 32)
        : base.allowedEnvVars
        ? [...base.allowedEnvVars].slice(0, 32)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// parsePolicy
// ---------------------------------------------------------------------------

const VALID_NETWORKS = new Set<string>(['none', 'host']);

/**
 * Parse a SandboxPolicy from a plain JSON object (e.g. deserialized from a DB
 * column). Unknown fields are silently dropped. Invalid typed fields fall back
 * to defaults. Always returns a complete SandboxPolicy.
 */
export function parsePolicy(raw: unknown): SandboxPolicy {
  if (raw === null || typeof raw !== 'object') {
    return { ...DEFAULT_SANDBOX_POLICY };
  }

  const r = raw as Record<string, unknown>;

  const enabled =
    typeof r['enabled'] === 'boolean' ? r['enabled'] : DEFAULT_SANDBOX_POLICY.enabled;

  const network =
    typeof r['network'] === 'string' && VALID_NETWORKS.has(r['network'])
      ? (r['network'] as 'none' | 'host')
      : DEFAULT_SANDBOX_POLICY.network;

  // FIX #2: require finite, positive, and within caps — rejects Infinity, NaN, or absurdly large values
  const cpuSeconds =
    typeof r['cpuSeconds'] === 'number'
    && Number.isFinite(r['cpuSeconds'])
    && r['cpuSeconds'] > 0
    && r['cpuSeconds'] <= 3600
      ? r['cpuSeconds']
      : DEFAULT_SANDBOX_POLICY.cpuSeconds;

  const memoryMB =
    typeof r['memoryMB'] === 'number'
    && Number.isFinite(r['memoryMB'])
    && r['memoryMB'] > 0
    && r['memoryMB'] <= 8192
      ? r['memoryMB']
      : DEFAULT_SANDBOX_POLICY.memoryMB;

  const maxFileMB =
    typeof r['maxFileMB'] === 'number'
    && Number.isFinite(r['maxFileMB'])
    && r['maxFileMB'] > 0
    && r['maxFileMB'] <= 1024
      ? r['maxFileMB']
      : DEFAULT_SANDBOX_POLICY.maxFileMB;

  const extraReadOnlyBinds = parseBindArray(r['extraReadOnlyBinds'], 'extraReadOnlyBinds');
  const extraWritableBinds = parseBindArray(r['extraWritableBinds'], 'extraWritableBinds');
  const allowedEnvVars = parseStringArray(r['allowedEnvVars']);

  return {
    enabled,
    network,
    cpuSeconds,
    memoryMB,
    maxFileMB,
    ...(extraReadOnlyBinds !== undefined && { extraReadOnlyBinds }),
    ...(extraWritableBinds !== undefined && { extraWritableBinds }),
    ...(allowedEnvVars !== undefined && { allowedEnvVars }),
    // P1 cross
    platform: (r['platform'] as any) || DEFAULT_SANDBOX_POLICY.platform,
    enableCrossPlatform: typeof r['enableCrossPlatform'] === 'boolean' ? r['enableCrossPlatform'] : DEFAULT_SANDBOX_POLICY.enableCrossPlatform,
  };
}

// ---------------------------------------------------------------------------
// parsePolicy helpers
// ---------------------------------------------------------------------------

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === 'string').slice(0, MAX_BIND_ENTRIES);
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Parse and validate a bind-path array from raw JSON.
 * Invalid paths are dropped with a warning rather than causing a hard failure at parse time.
 * FIX ITEM 1: push the normalized (canonical) path rather than the raw input,
 * so stored policy paths are always in canonical form.
 */
function parseBindArray(value: unknown, fieldName: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === 'string').slice(0, MAX_BIND_ENTRIES);
  const valid: string[] = [];
  for (const p of strings) {
    if (validateBindPath(p)) {
      // Push the canonical form, not the raw input
      valid.push(normalizeBind(p));
    } else {
      log.warn({ path: p, field: fieldName }, 'parsePolicy: invalid bind path dropped');
    }
  }
  return valid.length > 0 ? valid : undefined;
}
