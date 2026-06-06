/**
 * @file update-lock.ts
 * @description File-based lock for preventing concurrent SUDO-AI updates.
 *
 * Uses O_EXCL atomic file creation to prevent TOCTOU races.
 * Lock files contain { pid, acquiredAt, expiresAt } so stale locks
 * from crashed processes can be detected and recovered.
 *
 * Covers: acquire, release, isLocked, getLockInfo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import type { LockInfo } from './update-manager-types.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('update:lock');

// ---------------------------------------------------------------------------
// UpdateLock
// ---------------------------------------------------------------------------

export class UpdateLock {
  private readonly lockPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(lockDir: string = path.resolve('data'), defaultTimeoutMs: number = 300_000) {
    this.lockPath = path.join(lockDir, 'update.lock');
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire an exclusive lock. Creates a lock file with O_EXCL.
   * If a lock file exists but has expired, it is removed and acquisition is retried once.
   * @throws BusinessError('update_lock_held') if another process holds the lock.
   */
  acquire(timeoutMs?: number): LockInfo {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeout);

    const info: LockInfo = {
      pid: process.pid,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    try {
      fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), { flag: 'wx' });
      log.info({ pid: info.pid, lockPath: this.lockPath }, 'Update lock acquired');
      return info;
    } catch (err: unknown) {
      if (!(err instanceof Error) || !('code' in err) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      // Lock file exists — check if it's expired
      const existing = this._readLockInfo();
      if (existing && new Date(existing.expiresAt) > new Date()) {
        const msg = `Update lock held by PID ${existing.pid} (expires ${existing.expiresAt})`;
        log.warn({ existingPid: existing.pid, expiresAt: existing.expiresAt }, msg);
        throw new BusinessError(msg, 'update_lock_held', { pid: existing.pid, expiresAt: existing.expiresAt });
      }

      // Stale lock — remove and retry once
      log.info({ stalePid: existing?.pid }, 'Removing stale update lock');
      try {
        fs.unlinkSync(this.lockPath);
      } catch (_unlinkErr: unknown) {
        // Race: another process removed it — that's fine, retry will handle it
      }

      try {
        fs.writeFileSync(this.lockPath, JSON.stringify(info, null, 2), { flag: 'wx' });
        log.info({ pid: info.pid, lockPath: this.lockPath }, 'Update lock acquired (after stale removal)');
        return info;
      } catch (retryErr: unknown) {
        if (retryErr instanceof Error && 'code' in retryErr && (retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new BusinessError('Update lock acquisition failed after stale removal — another process acquired it', 'update_lock_held');
        }
        throw retryErr;
      }
    }
  }

  /**
   * Release the lock. No-op if the lock file doesn't exist.
   */
  release(): void {
    try {
      fs.unlinkSync(this.lockPath);
      log.info({ lockPath: this.lockPath }, 'Update lock released');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone — that's fine
        log.debug({ lockPath: this.lockPath }, 'Update lock already released');
        return;
      }
      throw err;
    }
  }

  /**
   * Check if a valid (non-expired) lock is currently held.
   */
  isLocked(): boolean {
    const info = this._readLockInfo();
    if (!info) return false;
    return new Date(info.expiresAt) > new Date();
  }

  /**
   * Read and parse the lock file. Returns null if it doesn't exist or is malformed.
   */
  getLockInfo(): LockInfo | null {
    return this._readLockInfo();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _readLockInfo(): LockInfo | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf-8');
      const parsed = JSON.parse(raw) as LockInfo;
      // Validate expected fields
      if (typeof parsed.pid === 'number' && typeof parsed.acquiredAt === 'string' && typeof parsed.expiresAt === 'string') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}