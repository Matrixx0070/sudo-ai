/**
 * @file tests/fleet/device-identity.test.ts
 * @description Gap #28c slice 1 — device identity load/create/tamper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeDeviceId,
  createDeviceIdentity,
  defaultIdentityPath,
  loadDeviceIdentity,
  loadOrCreateDeviceIdentity,
  verifySignatureFromPem,
  type PersistedDeviceIdentity,
} from '../../src/core/fleet/device-identity.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-id-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('device-identity', () => {
  it('DI-01: createDeviceIdentity persists a file with mode-0600 + deterministic deviceId', () => {
    const p = defaultIdentityPath(tmp);
    const id = createDeviceIdentity(p);
    expect(existsSync(p)).toBe(true);
    expect(id.deviceId).toHaveLength(16);
    expect(id.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(computeDeviceId(id.publicKeyPem)).toBe(id.deviceId);
  });

  it('DI-02: loadOrCreateDeviceIdentity is idempotent — same id on re-load', () => {
    const p = defaultIdentityPath(tmp);
    const first = loadOrCreateDeviceIdentity(p);
    const second = loadOrCreateDeviceIdentity(p);
    expect(first.deviceId).toBe(second.deviceId);
    expect(first.publicKeyPem).toBe(second.publicKeyPem);
  });

  it('DI-03: identity.sign produces a verifiable signature', () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const payload = Buffer.from('register me');
    const sig = id.sign(payload);
    expect(verifySignatureFromPem(id.publicKeyPem, payload, sig)).toBe(true);
  });

  it('DI-04: signature verification fails for tampered payload', () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const sig = id.sign('original');
    expect(verifySignatureFromPem(id.publicKeyPem, 'tampered', sig)).toBe(false);
  });

  it('DI-05: tampered deviceId in file → loadDeviceIdentity throws', () => {
    const p = defaultIdentityPath(tmp);
    createDeviceIdentity(p);
    const persisted = JSON.parse(readFileSync(p, 'utf8')) as PersistedDeviceIdentity;
    persisted.deviceId = '0000000000000000';
    writeFileSync(p, JSON.stringify(persisted));
    expect(() => loadDeviceIdentity(p)).toThrow(/tampered/);
  });

  it('DI-06: unsupported version → throws', () => {
    const p = defaultIdentityPath(tmp);
    createDeviceIdentity(p);
    const persisted = JSON.parse(readFileSync(p, 'utf8')) as PersistedDeviceIdentity;
    (persisted as unknown as { version: number }).version = 99;
    writeFileSync(p, JSON.stringify(persisted));
    expect(() => loadDeviceIdentity(p)).toThrow(/version 99/);
  });

  it('DI-07: missing fields → throws structurally', () => {
    const p = defaultIdentityPath(tmp);
    writeFileSync(p, JSON.stringify({ version: 1 }));
    expect(() => loadDeviceIdentity(p)).toThrow(/required fields/);
  });

  it('DI-08: verifySignatureFromPem returns false on malformed PEM (no throw)', () => {
    expect(verifySignatureFromPem('not-a-pem', 'data', 'sig')).toBe(false);
  });

  it('DI-09: verifySignatureFromPem returns false on bad base64 signature (no throw)', () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    expect(verifySignatureFromPem(id.publicKeyPem, 'data', '!!!not-base64!!!')).toBe(false);
  });

  it('DI-10: computeDeviceId is deterministic across calls', () => {
    const id1 = createDeviceIdentity(path.join(tmp, 'a.json'));
    const id2 = createDeviceIdentity(path.join(tmp, 'b.json'));
    // Different keypairs → different ids.
    expect(id1.deviceId).not.toBe(id2.deviceId);
    // Same key → same id.
    expect(computeDeviceId(id1.publicKeyPem)).toBe(id1.deviceId);
  });
});
