/**
 * @file version-resolver.ts
 * @description Version checking and integrity verification for SUDO-AI updates.
 *
 * Primary source: npm registry (dist-tags for channel resolution).
 * Fallback: git ls-remote for commit SHA comparison.
 * Includes: kill-switch, skip-version, max-version gating, semver comparison,
 *           and SHA-256 checksum verification.
 *
 * Covers: checkForUpdate, verifyChecksum, getCurrentGitSha, getRemoteVersion.
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import type { AutoUpdateConfig, UpdateChannel, VersionCheckResult, RemoteVersionInfo } from './update-manager-types.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('update:version-resolver');

// ---------------------------------------------------------------------------
// Semver comparison (lightweight, no external dep)
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings.
 * @returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('+')[0].split('-')[0].split('.').map(Number);
  const pb = b.replace(/^v/, '').split('+')[0].split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  // Pre-release comparison: pre-release < release
  const preA = a.includes('-') ? a.split('-')[1] : '';
  const preB = b.includes('-') ? b.split('-')[1] : '';
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA && preB) return preA === preB ? 0 : (preA < preB ? -1 : 1);
  return 0;
}

// ---------------------------------------------------------------------------
// VersionResolver
// ---------------------------------------------------------------------------

export class VersionResolver {
  private readonly config: AutoUpdateConfig;

  constructor(config: AutoUpdateConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check if an update is available.
   * Applies kill-switch, skip-version, max-version, and health gates first,
   * then queries npm registry (primary) or git remote (fallback).
   */
  async checkForUpdate(currentVersion: string, channel?: UpdateChannel): Promise<VersionCheckResult> {
    const ch = channel ?? this.config.channel;

    // Kill switch
    if (process.env['SUDO_UPDATE_DISABLE'] === '1') {
      log.info('Update disabled by SUDO_UPDATE_DISABLE=1');
      return { available: false, currentVersion, reason: 'kill_switch' };
    }

    // Skip version
    if (this.config.skipVersions.includes(currentVersion)) {
      log.info({ version: currentVersion }, 'Current version is in skip list');
      return { available: false, currentVersion, reason: 'skip_version' };
    }

    // Primary: npm registry
    try {
      const remote = await this.getRemoteVersion(ch);
      if (!remote) {
        log.warn({ channel: ch }, 'No remote version found via npm');
        // Fall through to git
      } else {
        // Max version cap
        if (this.config.maxVersion && compareSemver(remote.version, this.config.maxVersion) > 0) {
          log.info({ remote: remote.version, max: this.config.maxVersion }, 'Remote version exceeds max version cap');
          return { available: false, currentVersion, reason: 'kill_switch' };
        }

        const cmp = compareSemver(remote.version, currentVersion);
        if (cmp > 0) {
          log.info({ current: currentVersion, remote: remote.version, channel: ch }, 'Update available');
          return {
            available: true,
            currentVersion,
            newVersion: remote.version,
            channel: ch,
            checksumSha256: remote.shasum,
            sizeBytes: remote.sizeBytes,
          };
        }

        log.info({ current: currentVersion, remote: remote.version }, 'Already up to date');
        return { available: false, currentVersion, reason: 'up_to_date' };
      }
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err), channel: ch }, 'npm registry check failed — falling back to git');
    }

    // Fallback: git remote
    try {
      const remoteSha = this._getRemoteGitSha();
      const localSha = this.getCurrentGitSha();

      if (remoteSha && localSha && remoteSha !== localSha) {
        log.info({ localSha, remoteSha }, 'Git remote has different commit — update available');
        return {
          available: true,
          currentVersion,
          newVersion: `${currentVersion}+${remoteSha.substring(0, 8)}`,
          channel: ch,
          checksumSha256: '',  // Git fallback cannot provide checksums
          sizeBytes: 0,
        };
      }

      log.info({ localSha }, 'Git remote matches local — already up to date');
      return { available: false, currentVersion, reason: 'up_to_date' };
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Git fallback also failed');
      return { available: false, currentVersion, reason: 'up_to_date' };
    }
  }

  /**
   * Verify a file's SHA-256 checksum against an expected value.
   * @throws BusinessError('update_checksum_mismatch') on failure.
   */
  verifyChecksum(filePath: string, expectedSha256: string): void {
    if (!expectedSha256) {
      log.warn('No checksum provided — skipping verification');
      return;
    }

    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filePath);
    const actual = hash.update(data).digest('hex');

    if (actual !== expectedSha256) {
      log.error({ expected: expectedSha256, actual }, 'Checksum mismatch');
      throw new BusinessError(
        `Checksum mismatch: expected ${expectedSha256}, got ${actual}`,
        'update_checksum_mismatch',
        { expected: expectedSha256, actual },
      );
    }

    log.info({ filePath, sha256: actual }, 'Checksum verified');
  }

  /**
   * Get the current git HEAD SHA.
   */
  getCurrentGitSha(): string {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to get current git SHA');
      return '';
    }
  }

  /**
   * Fetch remote version info from npm registry.
   */
  async getRemoteVersion(channel: UpdateChannel): Promise<RemoteVersionInfo | null> {
    const packageName = this.config.packageName;
    const url = `https://registry.npmjs.org/${packageName}/${channel}`;

    log.info({ url, channel }, 'Fetching remote version from npm');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        log.warn({ status: res.status, url }, 'npm registry returned non-OK status');
        return null;
      }

      const data = await res.json() as Record<string, unknown>;

      // The channel tag response returns just the version string for dist-tags
      // But full registry endpoint returns the package metadata
      // Handle both cases
      if (typeof data === 'string') {
        return { version: data, shasum: '', sizeBytes: 0 };
      }

      // If we got the full metadata, extract version and dist info
      const version = data['version'] as string | undefined;
      if (!version) {
        log.warn('npm registry response missing version field');
        return null;
      }

      const dist = data['dist'] as Record<string, unknown> | undefined;
      const shasum = (dist?.['shasum'] as string) ?? '';
      const sizeBytes = (dist?.['unpackedSize'] as number) ?? 0;

      return { version, shasum, sizeBytes };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.warn({ url }, 'npm registry request timed out');
      } else {
        log.warn({ err: err instanceof Error ? err.message : String(err), url }, 'npm registry request failed');
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _getRemoteGitSha(): string {
    try {
      const output = execSync(
        `git ls-remote --refs ${this.config.gitRemoteUrl} refs/heads/${this.config.gitBranch}`,
        { encoding: 'utf-8', timeout: 15_000 },
      ).trim();
      // Output format: <sha>\trefs/heads/<branch>
      const match = output.match(/^([0-9a-f]{40})\s/);
      return match ? match[1] : '';
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to get remote git SHA');
      return '';
    }
  }
}