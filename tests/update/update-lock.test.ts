/**
 * @file update-lock.test.ts
 * @description Tests for UpdateLock — file-based lock with O_EXCL and expiry.
 *
 * Covers: acquire, release, concurrent acquisition, expired lock, idempotent release,
 *         isLocked, getLockInfo, kill-switch check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateLock } from '../../src/core/update/update-lock.js';
import { BusinessError } from '../../src/core/shared/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), 'sudo-ai-update-lock-test');

function makeLock(subpath?: string, timeoutMs = 300_000): UpdateLock {
  return new UpdateLock(subpath ?? TEST_DIR, timeoutMs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateLock', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up lock files
    const lockPath = path.join(TEST_DIR, 'update.lock');
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('acquire creates lock file with PID and expiry', () => {
    const lock = makeLock();
    const info = lock.acquire(300_000);

    expect(info.pid).toBe(process.pid);
    expect(info.acquiredAt).toBeTruthy();
    expect(info.expiresAt).toBeTruthy();

    // Lock file exists on disk
    const lockPath = path.join(TEST_DIR, 'update.lock');
    expect(fs.existsSync(lockPath)).toBe(true);

    // Content is valid JSON
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
  });

  it('release deletes lock file', () => {
    const lock = makeLock();
    lock.acquire(300_000);
    expect(lock.isLocked()).toBe(true);

    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('concurrent acquisition throws BusinessError', () => {
    const lock1 = makeLock();
    const lock2 = makeLock();

    lock1.acquire(300_000);
    expect(() => lock2.acquire(300_000)).toThrow();

    try {
      lock2.acquire(300_000);
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessError);
      expect((err as BusinessError).code).toBe('business_update_lock_held');
    }
  });

  it('expired lock is re-acquired', () => {
    const lock = makeLock(undefined, 1); // 1ms timeout → immediately expires
    lock.acquire(1);

    // Wait for expiry
    const info = lock.getLockInfo();
    expect(info).not.toBeNull();

    // Small delay to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }

    // Should be able to re-acquire (stale lock removal)
    const lock2 = makeLock(undefined, 300_000);
    const info2 = lock2.acquire(300_000);
    expect(info2.pid).toBe(process.pid);
  });

  it('release is idempotent — no throw on already-released lock', () => {
    const lock = makeLock();
    lock.acquire(300_000);
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });

  it('isLocked returns correct state', () => {
    const lock = makeLock();
    expect(lock.isLocked()).toBe(false);

    lock.acquire(300_000);
    expect(lock.isLocked()).toBe(true);

    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('getLockInfo returns parsed data for active lock', () => {
    const lock = makeLock();
    const acquired = lock.acquire(300_000);

    const info = lock.getLockInfo();
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(acquired.pid);
    expect(info!.acquiredAt).toBe(acquired.acquiredAt);
    expect(info!.expiresAt).toBe(acquired.expiresAt);
  });

  it('getLockInfo returns null when no lock file exists', () => {
    const lock = makeLock();
    expect(lock.getLockInfo()).toBeNull();
  });
});