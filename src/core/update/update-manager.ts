/**
 * @file update-manager.ts
 * @description Main orchestrator for SUDO-AI Auto-Update System.
 *
 * Manages the update lifecycle: periodic checking, health gating,
 * downloading, verifying, applying, and restarting. Integrates with
 * Watchdog for health checks and pm2 for process restart.
 *
 * Covers: start, stop, _checkCycle, _applyUpdate, _rollback,
 *         updateConfig, event emission.
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { AutoUpdateConfig, UpdateChannel, UpdateEventPayload, UpdateResult, VersionCheckResult } from './update-manager-types.js';
import { DEFAULT_UPDATE_CONFIG } from './update-manager-types.js';
import { UpdateLock } from './update-lock.js';
import { RollbackStore } from './rollback-store.js';
import { VersionResolver } from './version-resolver.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('update:manager');

// ---------------------------------------------------------------------------
// Watchdog interface (duck-typed — only needs isHealthy())
// ---------------------------------------------------------------------------

interface WatchdogLike {
  isHealthy(): boolean;
}

// ---------------------------------------------------------------------------
// AutoUpdateManager
// ---------------------------------------------------------------------------

export class AutoUpdateManager extends EventEmitter {
  private readonly config: AutoUpdateConfig;
  private readonly lock: UpdateLock;
  private readonly rollbackStore: RollbackStore;
  private readonly resolver: VersionResolver;
  private readonly watchdog?: WatchdogLike;

  private timer: ReturnType<typeof setInterval> | null = null;
  private currentVersion: string;
  private isUpdating = false;

  constructor(opts: {
    config: Partial<AutoUpdateConfig>;
    watchdog?: WatchdogLike;
  }) {
    super();
    this.config = { ...DEFAULT_UPDATE_CONFIG, ...opts.config };
    this.watchdog = opts.watchdog;

    const dataDir = path.resolve(this.config.projectRoot, 'data');
    this.lock = new UpdateLock(dataDir, this.config.lockTimeoutMs);
    this.rollbackStore = new RollbackStore(
      path.join(dataDir, 'update-versions.db'),
      this.config.rollbackVersions,
    );
    this.resolver = new VersionResolver(this.config);
    this.currentVersion = this._readPackageVersion();

    // Register current version in rollback store
    this._registerCurrentVersion();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the periodic update check cycle.
   * Respects SUDO_UPDATE_DISABLE and SUDO_SELF_BUILD_MODE kill switches.
   */
  start(): void {
    if (process.env['SUDO_UPDATE_DISABLE'] === '1') {
      log.info('Auto-update disabled by SUDO_UPDATE_DISABLE=1');
      return;
    }
    if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
      log.info('Auto-update disabled during self-build mode (SUDO_SELF_BUILD_MODE=1)');
      return;
    }
    if (!this.config.enabled) {
      log.info('Auto-update disabled in config');
      return;
    }

    const interval = Math.max(60_000, this.config.checkIntervalMs);
    log.info({ intervalMs: interval, channel: this.config.channel, currentVersion: this.currentVersion }, 'Starting auto-update cycle');

    this.timer = setInterval(() => {
      this._checkCycle().catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Update check cycle error');
      });
    }, interval);

    // Don't keep the process alive just for the update timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }

    // Run first check after a short delay (not immediately on boot)
    setTimeout(() => {
      this._checkCycle().catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Initial update check error');
      });
    }, 30_000).unref();
  }

  /**
   * Stop the periodic update cycle.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Auto-update cycle stopped');
    }
  }

  /**
   * Close all resources (for shutdown).
   */
  close(): void {
    this.stop();
    this.rollbackStore.close();
    log.info('AutoUpdateManager closed');
  }

  /**
   * Manually trigger a check for updates (used by CLI command).
   */
  async checkNow(channel?: UpdateChannel): Promise<VersionCheckResult> {
    return this.resolver.checkForUpdate(this.currentVersion, channel);
  }

  /**
   * Manually apply an update (used by CLI command).
   */
  async applyUpdate(channel?: UpdateChannel): Promise<UpdateResult> {
    const ch = channel ?? this.config.channel;
    return this._applyUpdate(ch);
  }

  /**
   * Manually rollback to the previous version (used by CLI command).
   */
  async rollback(): Promise<UpdateResult> {
    return this._rollback();
  }

  /**
   * Get the current version and update history status.
   */
  getStatus(): { currentVersion: string; currentGitSha: string; versions: ReturnType<RollbackStore['listVersions']> } {
    return {
      currentVersion: this.currentVersion,
      currentGitSha: this.resolver.getCurrentGitSha(),
      versions: this.rollbackStore.listVersions(),
    };
  }

  /**
   * Hot-apply config changes without restart.
   * Reschedules the timer if checkIntervalMs changed.
   */
  updateConfig(partial: Partial<AutoUpdateConfig>): void {
    const oldInterval = this.config.checkIntervalMs;
    Object.assign(this.config, partial);
    log.info({ updated: Object.keys(partial) }, 'Config hot-reloaded');

    if (partial.checkIntervalMs && partial.checkIntervalMs !== oldInterval) {
      log.info({ oldMs: oldInterval, newMs: partial.checkIntervalMs }, 'Rescheduling update timer due to interval change');
      this.stop();
      this.start();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: check cycle
  // -------------------------------------------------------------------------

  private async _checkCycle(): Promise<void> {
    // Self-build mode check
    if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
      log.debug('Skipping update check — self-build mode active');
      return;
    }

    // Lock check — another process is mid-update
    if (this.lock.isLocked()) {
      log.debug('Skipping update check — lock held by another process');
      return;
    }

    // Already updating
    if (this.isUpdating) {
      log.debug('Skipping update check — update already in progress');
      return;
    }

    this._emit('check', { fromVersion: this.currentVersion });

    const result = await this.resolver.checkForUpdate(this.currentVersion);

    if (!result.available) {
      log.debug({ reason: result.reason }, 'No update available');
      return;
    }

    log.info({
      current: this.currentVersion,
      remote: result.newVersion,
      channel: result.channel,
    }, 'Update available');

    // Health gate
    if (this.config.healthGate && this.watchdog && !this.watchdog.isHealthy()) {
      log.warn('Skipping update — system health is not OK');
      this._emit('check', { fromVersion: this.currentVersion, toVersion: result.newVersion, error: 'health_gate' });
      return;
    }

    // Auto-apply or notify
    if (this.config.autoApply) {
      await this._applyUpdate(result.channel);
    } else {
      log.info({ version: result.newVersion }, 'Update available but autoApply is disabled — notification only');
      this._emit('check', { fromVersion: this.currentVersion, toVersion: result.newVersion, channel: result.channel });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: apply update
  // -------------------------------------------------------------------------

  private async _applyUpdate(channel?: UpdateChannel): Promise<UpdateResult> {
    if (this.isUpdating) {
      return { success: false, fromVersion: this.currentVersion, stage: 'apply', error: 'update_in_progress' };
    }

    this.isUpdating = true;
    const startTime = Date.now();
    const fromVersion = this.currentVersion;
    let stashed = false;

    try {
      // Acquire lock
      this.lock.acquire(this.config.lockTimeoutMs);
      this._emit('download', { fromVersion });

      // Stash dirty working tree
      const dirty = this._isGitDirty();
      if (dirty) {
        log.info('Stashing dirty working tree before pull');
        this._exec('git stash');
        stashed = true;
      }

      // Pull latest
      this._emit('download', { fromVersion });
      log.info({ branch: this.config.gitBranch }, 'Pulling latest changes');
      this._exec(`git pull origin ${this.config.gitBranch}`);

      // Check if package.json changed
      const pkgChanged = this._execCapture('git diff HEAD@{1} --name-only -- package.json pnpm-lock.yaml').trim().length > 0;
      if (pkgChanged) {
        log.info('package.json changed — running pnpm install');
        this._exec('pnpm install --frozen-lockfile 2>/dev/null || pnpm install');
      }

      // Build
      this._emit('verify', { fromVersion });
      log.info('Building project');
      this._exec('pnpm build:cli');

      // Get new version info
      const newVersion = this._readPackageVersion();
      const newGitSha = this.resolver.getCurrentGitSha();

      // Record new version
      this.rollbackStore.recordVersion({
        version: newVersion,
        gitSha: newGitSha,
        installedAt: new Date().toISOString(),
        channel: channel ?? this.config.channel,
        checksumSha256: '',
        isActive: true,
      });

      this.currentVersion = newVersion;
      this._emit('apply', { fromVersion, toVersion: newVersion });

      // Restart via pm2
      this._emit('restart', { fromVersion, toVersion: newVersion });
      log.info('Restarting via pm2');
      this._exec('pm2 reload sudo-ai-v5 --update-env');

      this._emit('complete', { fromVersion, toVersion: newVersion, durationMs: Date.now() - startTime });
      return { success: true, fromVersion, toVersion: newVersion, stage: 'complete' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, stage: 'apply' }, 'Update failed');

      // Try to restore stashed changes (a successful stash leaves the tree
      // clean, so we must key off whether we stashed — not the dirty state).
      if (stashed) {
        try {
          this._exec('git stash pop 2>/dev/null || true');
        } catch {
          // Best effort
        }
      }

      this._emit('failed', { fromVersion, error: msg, durationMs: Date.now() - startTime });
      return { success: false, fromVersion, stage: 'apply', error: msg };
    } finally {
      try {
        this.lock.release();
      } catch {
        // Best effort
      }
      this.isUpdating = false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: rollback
  // -------------------------------------------------------------------------

  private async _rollback(): Promise<UpdateResult> {
    const fromVersion = this.currentVersion;

    try {
      const target = this.rollbackStore.getRollbackTarget();
      if (!target) {
        return { success: false, fromVersion, stage: 'rollback', error: 'no_rollback_target' };
      }

      this.lock.acquire(this.config.lockTimeoutMs);
      this._emit('rollback', { fromVersion, toVersion: target.version });

      log.info({ targetSha: target.gitSha, targetVersion: target.version }, 'Rolling back to previous version');

      // Reset to target commit
      this._exec(`git reset --hard ${target.gitSha}`);

      // Rebuild
      this._exec('pnpm install --frozen-lockfile 2>/dev/null || pnpm install');
      this._exec('pnpm build:cli');

      // Mark target as active
      this.rollbackStore.markActive(target.id);
      this.currentVersion = target.version;

      // Restart
      this._exec('pm2 reload sudo-ai-v5 --update-env');

      this._emit('complete', { fromVersion, toVersion: target.version });
      return { success: true, fromVersion, toVersion: target.version, stage: 'complete' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, stage: 'rollback' }, 'Rollback failed');
      this._emit('failed', { fromVersion, error: msg });
      return { success: false, fromVersion, stage: 'rollback', error: msg };
    } finally {
      try {
        this.lock.release();
      } catch {
        // Best effort
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: utilities
  // -------------------------------------------------------------------------

  private _emit(stage: string, extra: Partial<UpdateEventPayload> = {}): void {
    this.emit('update', {
      stage: stage as UpdateEventPayload['stage'],
      timestamp: new Date().toISOString(),
      ...extra,
    } satisfies UpdateEventPayload);
  }

  private _readPackageVersion(): string {
    try {
      const pkgPath = path.join(this.config.projectRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private _registerCurrentVersion(): void {
    const existing = this.rollbackStore.getCurrentVersion();
    const currentGitSha = this.resolver.getCurrentGitSha();

    // Only register if no active version matches current
    if (!existing || existing.version !== this.currentVersion || existing.gitSha !== currentGitSha) {
      this.rollbackStore.recordVersion({
        version: this.currentVersion,
        gitSha: currentGitSha,
        installedAt: new Date().toISOString(),
        channel: this.config.channel,
        checksumSha256: '',
        isActive: true,
      });
      log.info({ version: this.currentVersion, gitSha: currentGitSha }, 'Registered current version in rollback store');
    }
  }

  private _isGitDirty(): boolean {
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],  // npm installs have no .git — keep git's "fatal:" off the console
      }).trim();
      return status.length > 0;
    } catch {
      return false;
    }
  }

  private _exec(cmd: string): void {
    execSync(cmd, {
      cwd: this.config.projectRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });
  }

  private _execCapture(cmd: string): string {
    try {
      return execSync(cmd, {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      });
    } catch {
      return '';
    }
  }
}