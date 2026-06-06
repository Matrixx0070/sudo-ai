/**
 * @file rollback-store.test.ts
 * @description Tests for RollbackStore — SQLite version history with pruning.
 *
 * Covers: recordVersion, getCurrentVersion, getRollbackTarget, listVersions,
 *         markActive, pruning, close.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { RollbackStore } from '../../src/core/update/rollback-store.js';
import type { UpdateChannel } from '../../src/core/update/update-manager-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), 'sudo-ai-rollback-store-test');

function createStore(rollbackVersions = 3): RollbackStore {
  const dbPath = path.join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.db`);
  return new RollbackStore(dbPath, rollbackVersions);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RollbackStore', () => {
  let store: RollbackStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    store = createStore();
  });

  afterEach(() => {
    store.close();
  });

  it('records and retrieves current version', () => {
    const record = store.recordVersion({
      version: '4.1.0',
      gitSha: 'abc123def456',
      installedAt: new Date().toISOString(),
      channel: 'latest' as UpdateChannel,
      checksumSha256: 'sha256abc',
      isActive: true,
    });

    expect(record.id).toBeTruthy();
    expect(record.version).toBe('4.1.0');
    expect(record.isActive).toBe(true);

    const current = store.getCurrentVersion();
    expect(current).not.toBeNull();
    expect(current!.version).toBe('4.1.0');
    expect(current!.gitSha).toBe('abc123def456');
  });

  it('deactivates older versions when recording a new one', () => {
    store.recordVersion({
      version: '4.1.0',
      gitSha: 'aaa',
      installedAt: new Date().toISOString(),
      channel: 'latest',
      checksumSha256: '',
      isActive: true,
    });

    store.recordVersion({
      version: '4.2.0',
      gitSha: 'bbb',
      installedAt: new Date().toISOString(),
      channel: 'latest',
      checksumSha256: '',
      isActive: true,
    });

    const current = store.getCurrentVersion();
    expect(current!.version).toBe('4.2.0');
    expect(current!.isActive).toBe(true);

    const rollback = store.getRollbackTarget();
    expect(rollback).not.toBeNull();
    expect(rollback!.version).toBe('4.1.0');
    expect(rollback!.isActive).toBe(false);
  });

  it('selects rollback target as most recently deactivated version', () => {
    // Insert with small time gaps to ensure deterministic ordering
    const v1 = store.recordVersion({ version: '4.0.0', gitSha: 'a1', installedAt: '2026-01-01T00:00:00Z', channel: 'latest', checksumSha256: '', isActive: true });
    const v2 = store.recordVersion({ version: '4.1.0', gitSha: 'b1', installedAt: '2026-01-02T00:00:00Z', channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.2.0', gitSha: 'c1', installedAt: '2026-01-03T00:00:00Z', channel: 'latest', checksumSha256: '', isActive: true });

    const target = store.getRollbackTarget();
    expect(target).not.toBeNull();
    // The most recently deactivated version is 4.1.0 (deactivated when 4.2.0 became active)
    expect(target!.version).toBe('4.1.0');
  });

  it('prunes inactive versions beyond rollbackVersions limit', () => {
    const store = createStore(2); // Keep only 2 inactive versions

    store.recordVersion({ version: '4.0.0', gitSha: 'a', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.1.0', gitSha: 'b', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.2.0', gitSha: 'c', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.3.0', gitSha: 'd', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.4.0', gitSha: 'e', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });

    // Only 2 inactive versions should remain (4.3.0 and 4.2.0), 4.0.0 and 4.1.0 pruned
    const all = store.listVersions(100);
    const inactiveCount = all.filter(v => !v.isActive).length;
    expect(inactiveCount).toBeLessThanOrEqual(2);

    store.close();
  });

  it('listVersions returns records ordered by most recent first', () => {
    store.recordVersion({ version: '4.0.0', gitSha: 'a', installedAt: '2026-01-01T00:00:00Z', channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.1.0', gitSha: 'b', installedAt: '2026-01-02T00:00:00Z', channel: 'latest', checksumSha256: '', isActive: true });
    store.recordVersion({ version: '4.2.0', gitSha: 'c', installedAt: '2026-01-03T00:00:00Z', channel: 'stable', checksumSha256: '', isActive: true });

    const versions = store.listVersions(10);
    expect(versions.length).toBe(3);
    // Most recent first
    expect(versions[0].version).toBe('4.2.0');
    expect(versions[0].channel).toBe('stable');
  });

  it('markActive switches active version', () => {
    store.recordVersion({ version: '4.1.0', gitSha: 'a', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    const v2 = store.recordVersion({ version: '4.2.0', gitSha: 'b', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });

    expect(store.getCurrentVersion()!.version).toBe('4.2.0');

    // Roll back to 4.1.0
    store.markActive(v2.id); // Wait, v2 is 4.2.0, which is already active
    // Actually we want to roll back to 4.1.0
    const target = store.getRollbackTarget();
    store.markActive(target!.id);

    expect(store.getCurrentVersion()!.version).toBe('4.1.0');
    expect(store.getCurrentVersion()!.isActive).toBe(true);
  });

  it('markActive throws for non-existent ID', () => {
    expect(() => store.markActive('nonexistent-id')).toThrow();
  });

  it('getCurrentVersion returns null for empty store', () => {
    expect(store.getCurrentVersion()).toBeNull();
  });

  it('getRollbackTarget returns null when only one version exists', () => {
    store.recordVersion({ version: '4.1.0', gitSha: 'a', installedAt: new Date().toISOString(), channel: 'latest', checksumSha256: '', isActive: true });
    expect(store.getRollbackTarget()).toBeNull();
  });
});