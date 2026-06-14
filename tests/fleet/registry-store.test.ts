/**
 * @file tests/fleet/registry-store.test.ts
 * @description Gap #28c slice 1 — SQLite-backed device registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RegistryStore } from '../../src/core/fleet/registry-store.js';

let tmp: string;
let store: RegistryStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-store-'));
  store = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const baseInput = {
  deviceId: 'aaaa1111bbbb2222',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
  hostname: 'device-1',
  versionStr: '4.1.0',
};

describe('RegistryStore', () => {
  it('RS-01: upsert inserts a new row', () => {
    const row = store.upsert({ ...baseInput });
    expect(row.deviceId).toBe(baseInput.deviceId);
    expect(row.hostname).toBe('device-1');
    expect(row.firstRegisteredAt).toBe(row.lastRegisteredAt);
    expect(store.count()).toBe(1);
  });

  it('RS-02: upsert updates last_registered_at but PRESERVES first_registered_at', async () => {
    const first = store.upsert({ ...baseInput, now: new Date('2026-01-01T00:00:00Z') });
    const second = store.upsert({ ...baseInput, hostname: 'renamed', now: new Date('2026-02-01T00:00:00Z') });
    expect(second.firstRegisteredAt).toBe(first.firstRegisteredAt);
    expect(second.lastRegisteredAt).not.toBe(first.lastRegisteredAt);
    expect(second.hostname).toBe('renamed');
    expect(store.count()).toBe(1);
  });

  it('RS-03: list returns most-recent first', () => {
    store.upsert({ ...baseInput, deviceId: 'aaaaaaaaaaaaaaaa', now: new Date('2026-01-01T00:00:00Z') });
    store.upsert({ ...baseInput, deviceId: 'bbbbbbbbbbbbbbbb', now: new Date('2026-01-02T00:00:00Z') });
    store.upsert({ ...baseInput, deviceId: 'cccccccccccccccc', now: new Date('2026-01-03T00:00:00Z') });
    const list = store.list();
    expect(list.map((d) => d.deviceId)).toEqual(['cccccccccccccccc', 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
  });

  it('RS-04: list clamps limit to [1, 1000]', () => {
    for (let i = 0; i < 5; i++) {
      store.upsert({ ...baseInput, deviceId: `dev-${i}`.padEnd(16, '0') });
    }
    expect(store.list(-5).length).toBe(1); // clamped to 1
    expect(store.list(99999).length).toBe(5); // clamped to 1000 then by row count
  });

  it('RS-05: get returns undefined for unknown device', () => {
    expect(store.get('not-present')).toBeUndefined();
  });

  it('RS-06: metadata is JSON-encoded; empty metadata stored as null', () => {
    const row1 = store.upsert({ ...baseInput, deviceId: 'm-empty'.padEnd(16, '0') });
    expect(row1.metadataJson).toBeNull();
    const row2 = store.upsert({ ...baseInput, deviceId: 'm-full'.padEnd(16, '0'), metadata: { k: 'v' } });
    expect(row2.metadataJson).toBe('{"k":"v"}');
    const row3 = store.upsert({ ...baseInput, deviceId: 'm-clear'.padEnd(16, '0'), metadata: {} });
    expect(row3.metadataJson).toBeNull();
  });

  it('RS-07: constructor is idempotent — same db reopens with existing rows', () => {
    store.upsert({ ...baseInput });
    store.close();
    const reopened = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
    expect(reopened.count()).toBe(1);
    expect(reopened.get(baseInput.deviceId)?.hostname).toBe('device-1');
    reopened.close();
  });
});
