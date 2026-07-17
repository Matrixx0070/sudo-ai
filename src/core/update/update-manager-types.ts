/**
 * @file update-manager-types.ts
 * @description Type definitions and defaults for the SUDO-AI Auto-Update System.
 *
 * Covers: version checking, update channels, lifecycle stages, config schema,
 * version records, and event payloads.
 */

// ---------------------------------------------------------------------------
// Enums / Literal types
// ---------------------------------------------------------------------------

/** Update channel — maps to npm dist-tags. */
export type UpdateChannel = 'latest' | 'stable';

/** Lifecycle stages emitted as events. */
export type UpdateStage =
  | 'check'
  | 'download'
  | 'verify'
  | 'pre-apply'
  | 'apply'
  | 'restart'
  | 'rollback'
  | 'complete'
  | 'failed';

// ---------------------------------------------------------------------------
// Discriminated result types
// ---------------------------------------------------------------------------

/** Result of a version check. */
export type VersionCheckResult =
  | {
      available: true;
      currentVersion: string;
      newVersion: string;
      channel: UpdateChannel;
      checksumSha256: string;
      sizeBytes: number;
    }
  | {
      available: false;
      currentVersion: string;
      reason: 'up_to_date' | 'kill_switch' | 'skip_version' | 'health_gate';
    };

/** Result of a full update attempt. */
export type UpdateResult =
  | { success: true; fromVersion: string; toVersion: string; stage: 'complete' }
  | { success: false; fromVersion: string; toVersion?: string; stage: UpdateStage; error: string };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** AutoUpdateManager configuration.
 *
 *  Resolution order (highest wins):
 *  1. Environment variables (SUDO_UPDATE_*)
 *  2. config/sudo-ai.json5 `update` section
 *  3. DEFAULT_UPDATE_CONFIG
 */
export interface AutoUpdateConfig {
  /** Enable or disable the auto-update system. Kill-switch: SUDO_UPDATE_DISABLE=1 overrides. */
  enabled: boolean;
  /** Which channel to track. Default 'latest'. */
  channel: UpdateChannel;
  /** Check interval in ms. Default 1 800 000 (30 min). Minimum 60 000. */
  checkIntervalMs: number;
  /** Number of previous versions to retain for rollback. Default 3. */
  rollbackVersions: number;
  /** Whether to apply updates automatically or just notify. Default true. */
  autoApply: boolean;
  /** Whether to verify SHA-256 checksums before applying. Default true. */
  verifyChecksums: boolean;
  /** Maximum version to install (kill switch). Undefined = no limit. */
  maxVersion?: string;
  /** Specific versions to skip (known-bad releases). */
  skipVersions: string[];
  /** Health gate: block updates when Watchdog reports critical. Default true. */
  healthGate: boolean;
  /** Lock file timeout in ms. Default 300 000 (5 min). */
  lockTimeoutMs: number;
  /** npm package name. Default 'sudo-ai'. */
  packageName: string;
  /** Git remote URL for git-based fallback resolution. */
  gitRemoteUrl: string;
  /** Git branch for version resolution. Default 'main'. */
  gitBranch: string;
  /** Project root path. Defaults to process.cwd(). */
  projectRoot: string;
}

/**
 * Read `SUDO_UPDATE_*` environment overrides — the documented precedence
 * tier 1 for AutoUpdateConfig (previously documented but unimplemented, so
 * prod env entries were silently inert). Invalid or empty values are ignored
 * and fall through to lower tiers rather than throwing.
 * `SUDO_UPDATE_DISABLE` stays a runtime kill-switch checked at call sites.
 */
export function readUpdateEnvOverrides(env: NodeJS.ProcessEnv = process.env): Partial<AutoUpdateConfig> {
  const out: Partial<AutoUpdateConfig> = {};
  const bool = (v: string | undefined): boolean | undefined =>
    v === '1' ? true : v === '0' ? false : undefined;

  const autoApply = bool(env['SUDO_UPDATE_AUTO_APPLY']);
  if (autoApply !== undefined) out.autoApply = autoApply;

  const healthGate = bool(env['SUDO_UPDATE_HEALTH_GATE']);
  if (healthGate !== undefined) out.healthGate = healthGate;

  const channel = env['SUDO_UPDATE_CHANNEL'];
  if (channel === 'latest' || channel === 'stable') out.channel = channel;

  const interval = Number(env['SUDO_UPDATE_INTERVAL_MS']);
  if (Number.isFinite(interval) && interval >= 60_000) out.checkIntervalMs = interval;

  const rollback = Number(env['SUDO_UPDATE_ROLLBACK_VERSIONS']);
  if (Number.isInteger(rollback) && rollback >= 0) out.rollbackVersions = rollback;

  const maxVersion = env['SUDO_UPDATE_MAX_VERSION']?.trim();
  if (maxVersion) out.maxVersion = maxVersion;

  const skip = env['SUDO_UPDATE_SKIP_VERSIONS']?.trim();
  if (skip) out.skipVersions = skip.split(',').map((v) => v.trim()).filter(Boolean);

  return out;
}

/** Default configuration values. */
export const DEFAULT_UPDATE_CONFIG: Readonly<AutoUpdateConfig> = {
  enabled: true,
  channel: 'latest',
  checkIntervalMs: 1_800_000,
  rollbackVersions: 3,
  autoApply: true,
  verifyChecksums: true,
  skipVersions: [],
  healthGate: true,
  lockTimeoutMs: 300_000,
  packageName: 'sudo-ai',
  gitRemoteUrl: 'https://github.com/Matrixx0070/sudo-ai.git',
  gitBranch: 'main',
  projectRoot: process.cwd(),
} as const;

// ---------------------------------------------------------------------------
// Version record (stored in rollback-store)
// ---------------------------------------------------------------------------

export interface VersionRecord {
  /** nanoid-generated unique ID. */
  id: string;
  /** Semantic version string, e.g. "4.1.0". */
  version: string;
  /** Git commit SHA. */
  gitSha: string;
  /** ISO timestamp when this version was installed. */
  installedAt: string;
  /** Channel that delivered this version. */
  channel: UpdateChannel;
  /** SHA-256 of the npm tarball (for integrity verification). Empty string for git-based installs. */
  checksumSha256: string;
  /** Whether this version is the currently active one. */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface UpdateEventPayload {
  stage: UpdateStage;
  timestamp: string;
  fromVersion?: string;
  toVersion?: string;
  channel?: UpdateChannel;
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Lock file info
// ---------------------------------------------------------------------------

export interface LockInfo {
  /** PID of the process holding the lock. */
  pid: number;
  /** ISO timestamp when the lock was acquired. */
  acquiredAt: string;
  /** ISO timestamp when the lock expires. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Remote version info (from npm registry)
// ---------------------------------------------------------------------------

export interface RemoteVersionInfo {
  version: string;
  shasum: string;
  sizeBytes: number;
  distTags?: Record<string, string>;
}