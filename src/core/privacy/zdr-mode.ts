/**
 * ZDR (Zero Data Retention) Mode — privacy-first operation for SUDO-AI.
 *
 * Mirrors Grok Build CLI's `coding_data_retention_opt_out` flag and
 * `RepoVisibilityCheck` pattern. When ZDR is active:
 *
 * - No conversation data is persisted to disk (session files, memory, logs)
 * - No telemetry is sent to remote APIs
 * - Consciousness episodic memory recording is disabled
 * - World model predictions are not persisted
 * - Structured memory writes are suppressed
 * - Only in-memory processing occurs; everything is discarded on exit
 *
 * ZDR is enabled via:
 *  - Environment: SUDO_ZDR=1 or SUDO_DATA_RETENTION_OPT_OUT=1
 *  - Config file: data_retention_opt_out = true
 *  - CLI flag: --zdr or --no-data-retention
 *  - JWT claim: coding_data_retention_opt_out = true
 *
 * RepoVisibilityCheck:
 *  - Auto-detects if the working directory is a public or private repo
 *  - Enforces stricter ZDR defaults for private repos
 *  - Blocks telemetry upload for private repos even when ZDR is off
 */

import { createLogger } from '../shared/logger.js';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const log = createLogger('privacy:zdr');

// ---------------------------------------------------------------------------
// ZDR Configuration
// ---------------------------------------------------------------------------

export interface ZDRConfig {
  /** Whether ZDR (zero data retention) mode is active. */
  enabled: boolean;
  /** Source of the ZDR flag (env, config, cli, jwt). */
  source: 'env' | 'config' | 'cli' | 'jwt' | 'default';
  /** Whether telemetry uploads are blocked regardless of ZDR. */
  blockTelemetry: boolean;
  /** Whether session persistence is disabled. */
  blockSessionPersistence: boolean;
  /** Whether memory writes are disabled. */
  blockMemoryWrites: boolean;
  /** Whether consciousness recording is disabled. */
  blockConsciousnessRecording: boolean;
  /** Whether this is a private repo (auto-detected). */
  isPrivateRepo: boolean | null;
}

const DEFAULT_CONFIG: ZDRConfig = {
  enabled: false,
  source: 'default',
  blockTelemetry: false,
  blockSessionPersistence: false,
  blockMemoryWrites: false,
  blockConsciousnessRecording: false,
  isPrivateRepo: null,
};

// ---------------------------------------------------------------------------
// Repo Visibility Check
// ---------------------------------------------------------------------------

export type RepoVisibility = 'public' | 'private' | 'unknown';

/**
 * Auto-detect whether the working directory is a public or private repo.
 * Uses `git remote get-url` + heuristic URL analysis.
 *
 * - GitHub/GitLab URLs without auth tokens → likely public
 * - SSH URLs (git@) → likely private
 * - Unknown remote → unknown
 */
export function detectRepoVisibility(cwd?: string): RepoVisibility {
  try {
    const remoteUrl = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf8',
      cwd: cwd ?? process.cwd(),
      timeout: 5000,
    }).trim();

    if (!remoteUrl) return 'unknown';

    // SSH URLs are almost always private repos
    if (remoteUrl.startsWith('git@')) return 'private';

    // HTTPS URLs with auth tokens are private
    if (remoteUrl.match(/:\/\/[^:]+:[^@]+@/)) return 'private';

    // Standard HTTPS URLs — could be either, default to public
    // (user can override with SUDO_REPO_VISIBILITY=private)
    return 'public';
  } catch {
    return 'unknown';
  }
}

/**
 * Check the SUDO_REPO_VISIBILITY environment variable override.
 */
export function getRepoVisibilityOverride(): RepoVisibility | null {
  const val = process.env['SUDO_REPO_VISIBILITY'];
  if (val === 'public') return 'public';
  if (val === 'private') return 'private';
  return null;
}

// ---------------------------------------------------------------------------
// ZDR Mode Manager
// ---------------------------------------------------------------------------

/**
 * Manages Zero Data Retention mode configuration and enforcement.
 *
 * Call `resolve()` once at startup to compute the effective ZDR config from
 * all sources (env, config, CLI, JWT). Then use `isBlocked()` to gate
 * operations at runtime.
 */
export class ZDRModeManager {
  private config: ZDRConfig = { ...DEFAULT_CONFIG };
  private _resolved = false;

  /**
   * Resolve the effective ZDR configuration from all sources.
   * Should be called once at startup.
   *
   * Priority (highest to lowest):
   *  1. CLI flag (--zdr)
   *  2. JWT claim (coding_data_retention_opt_out)
   *  3. Environment (SUDO_ZDR, SUDO_DATA_RETENTION_OPT_OUT)
   *  4. Config file (data_retention_opt_out)
   *  5. Repo visibility (private → partial ZDR)
   *  6. Default (no ZDR)
   */
  resolve(opts?: {
    cliFlag?: boolean;
    jwtClaim?: boolean;
    configFile?: boolean;
  }): ZDRConfig {
    const cliFlag = opts?.cliFlag ?? false;
    const jwtClaim = opts?.jwtClaim ?? false;
    const configFile = opts?.configFile ?? false;

    // Check sources in priority order
    if (cliFlag) {
      this.config.enabled = true;
      this.config.source = 'cli';
    } else if (jwtClaim) {
      this.config.enabled = true;
      this.config.source = 'jwt';
    } else if (this._checkEnv()) {
      this.config.enabled = true;
      this.config.source = 'env';
    } else if (configFile) {
      this.config.enabled = true;
      this.config.source = 'config';
    }

    // Repo visibility — auto-detect and enforce
    const override = getRepoVisibilityOverride();
    const visibility = override ?? detectRepoVisibility();
    this.config.isPrivateRepo = visibility === 'private';

    // Apply ZDR effects
    if (this.config.enabled) {
      this.config.blockTelemetry = true;
      this.config.blockSessionPersistence = true;
      this.config.blockMemoryWrites = true;
      this.config.blockConsciousnessRecording = true;
      log.info(
        { source: this.config.source, isPrivateRepo: this.config.isPrivateRepo },
        'ZDR mode active — all data retention blocked',
      );
    } else if (this.config.isPrivateRepo) {
      // Even without full ZDR, block telemetry for private repos
      this.config.blockTelemetry = true;
      log.info('Private repo detected — telemetry blocked');
    }

    // Per-channel privacy policy (F105): SUDO_ZDR_CHANNELS=telegram,email marks
    // those channels ZDR even when the global flag is off. Additive to any
    // programmatic setChannelPrivacy() registrations.
    loadChannelPrivacyFromEnv();

    this._resolved = true;
    return { ...this.config };
  }

  /**
   * Check whether a specific data operation is blocked by ZDR.
   *
   * @param operation - The type of data operation to check.
   * @returns True if the operation should be blocked.
   */
  isBlocked(operation: 'session_persistence' | 'memory_write' | 'telemetry' | 'consciousness_recording' | 'trace_upload'): boolean {
    if (!this._resolved) {
      log.warn('isBlocked() called before resolve() — auto-resolving with defaults');
      this.resolve();
    }

    switch (operation) {
      case 'session_persistence':
        return this.config.blockSessionPersistence;
      case 'memory_write':
        return this.config.blockMemoryWrites;
      case 'telemetry':
        return this.config.blockTelemetry;
      case 'consciousness_recording':
        return this.config.blockConsciousnessRecording;
      case 'trace_upload':
        return this.config.blockTelemetry; // trace upload is a form of telemetry
      default:
        return this.config.enabled; // if ZDR is on, block everything by default
    }
  }

  /** Get the current effective ZDR config. */
  getConfig(): ZDRConfig {
    return { ...this.config };
  }

  /** Check if ZDR is currently active. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Check if telemetry is blocked (either by ZDR or private repo). */
  isTelemetryBlocked(): boolean {
    return this.config.blockTelemetry;
  }

  /**
   * Force-enable ZDR at runtime (e.g., via admin API or consciousness-control).
   * Cannot be disabled once enabled (one-way gate for safety).
   */
  forceEnable(source: string): void {
    if (this.config.enabled) {
      log.debug({ currentSource: this.config.source, newSource: source }, 'ZDR already enabled — ignoring force-enable');
      return;
    }
    this.config.enabled = true;
    this.config.source = source as ZDRConfig['source'];
    this.config.blockTelemetry = true;
    this.config.blockSessionPersistence = true;
    this.config.blockMemoryWrites = true;
    this.config.blockConsciousnessRecording = true;
    log.info({ source }, 'ZDR force-enabled at runtime');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _checkEnv(): boolean {
    return (
      process.env['SUDO_ZDR'] === '1' ||
      process.env['SUDO_ZDR'] === 'true' ||
      process.env['SUDO_DATA_RETENTION_OPT_OUT'] === '1' ||
      process.env['SUDO_DATA_RETENTION_OPT_OUT'] === 'true'
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton (lazy — only created when first imported)
// ---------------------------------------------------------------------------

let _instance: ZDRModeManager | null = null;

/**
 * Get the global ZDRModeManager singleton.
 * Call `resolve()` on it once at startup.
 */
export function getZDRManager(): ZDRModeManager {
  if (!_instance) {
    _instance = new ZDRModeManager();
  }
  return _instance;
}

/**
 * Test hook: drop the ZDR singleton + clear per-channel registrations so the
 * next getZDRManager()/isZDRBlocked() re-resolves from the current environment.
 */
export function __resetZDRManager(): void {
  _instance = null;
  clearChannelPrivacy();
}

/**
 * Convenience: check if a data operation is blocked by ZDR.
 * Uses the global singleton. Auto-resolves if not yet resolved.
 */
export function isZDRBlocked(operation: Parameters<ZDRModeManager['isBlocked']>[0]): boolean {
  return getZDRManager().isBlocked(operation);
}

// ---------------------------------------------------------------------------
// Per-channel privacy policy hook (F105)
// ---------------------------------------------------------------------------
//
// A channel can declare `privacy: 'zdr'` so its turns are treated as
// zero-data-retention even when the global SUDO_ZDR flag is OFF. This is the
// seam where per-channel config flows into the persistence gate: content-bearing
// persistence paths call isZDRBlockedForChannel(op, channel) instead of the
// global isZDRBlocked(op), and get ZDR semantics for that channel alone.
//
// Sources (union): programmatic setChannelPrivacy() + the SUDO_ZDR_CHANNELS env
// list (comma/space separated), loaded at resolve() time.

export type ChannelPrivacyPolicy = 'zdr' | 'standard';

/** Content-bearing ZDR operations a per-channel 'zdr' policy suppresses. */
const CHANNEL_CONTENT_OPERATIONS: ReadonlySet<
  Parameters<ZDRModeManager['isBlocked']>[0]
> = new Set(['session_persistence', 'memory_write', 'consciousness_recording']);

/** channel id -> policy. Only non-default ('zdr') channels are stored. */
const _channelPrivacy = new Map<string, ChannelPrivacyPolicy>();

/**
 * Declare a per-channel privacy policy. 'zdr' marks the channel for
 * zero-data-retention on content paths; 'standard' clears any prior mark.
 */
export function setChannelPrivacy(channel: string, policy: ChannelPrivacyPolicy): void {
  if (!channel) return;
  if (policy === 'zdr') _channelPrivacy.set(channel, 'zdr');
  else _channelPrivacy.delete(channel);
}

/** Get the effective policy for a channel ('standard' when unset). */
export function getChannelPrivacy(channel: string | null | undefined): ChannelPrivacyPolicy {
  return channel != null && _channelPrivacy.get(channel) === 'zdr' ? 'zdr' : 'standard';
}

/** True when this specific channel is ZDR (regardless of the global flag). */
export function isChannelZDR(channel: string | null | undefined): boolean {
  return channel != null && _channelPrivacy.get(channel) === 'zdr';
}

/** Clear all per-channel privacy registrations (tests / re-resolve). */
export function clearChannelPrivacy(): void {
  _channelPrivacy.clear();
}

/**
 * Load per-channel ZDR marks from SUDO_ZDR_CHANNELS (comma/space separated
 * channel ids). Additive — never clears programmatic registrations. Idempotent.
 */
export function loadChannelPrivacyFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env['SUDO_ZDR_CHANNELS'];
  if (!raw || !raw.trim()) return;
  for (const ch of raw.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean)) {
    _channelPrivacy.set(ch, 'zdr');
  }
}

/**
 * Channel-aware ZDR gate. Blocks when the GLOBAL flag blocks the op, OR when the
 * given channel is marked ZDR and the op is a content-bearing operation.
 * Operational-metadata ops (telemetry/trace_upload) are unaffected by a channel
 * mark — a channel opting into ZDR suppresses its user content, not system
 * counters. Falls back to the global gate when channel is undefined.
 */
export function isZDRBlockedForChannel(
  operation: Parameters<ZDRModeManager['isBlocked']>[0],
  channel?: string | null,
): boolean {
  if (isZDRBlocked(operation)) return true;
  if (isChannelZDR(channel) && CHANNEL_CONTENT_OPERATIONS.has(operation)) return true;
  return false;
}
