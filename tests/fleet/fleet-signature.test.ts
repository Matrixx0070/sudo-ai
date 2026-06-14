/**
 * @file tests/fleet/fleet-signature.test.ts
 * @description Gap #28c slice 2 — per-request signature scheme.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDeviceIdentity,
  defaultIdentityPath,
  type DeviceIdentity,
} from '../../src/core/fleet/device-identity.js';
import {
  fleetRequestSigningInput,
  signFleetRequest,
  verifyFleetRequest,
} from '../../src/core/fleet/fleet-signature.js';

let tmp: string;
let id: DeviceIdentity;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-sig-'));
  id = createDeviceIdentity(defaultIdentityPath(tmp));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('fleet-signature', () => {
  it('SIG-01: signFleetRequest produces headers verifiable by verifyFleetRequest', () => {
    const path = `/api/fleet/device/${id.deviceId}/inbox`;
    const h = signFleetRequest({ method: 'GET', path, identity: id });
    const r = verifyFleetRequest({
      method: 'GET',
      path,
      headers: h,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r.ok).toBe(true);
  });

  it('SIG-02: signature does NOT verify under a different method (verb binding)', () => {
    const path = `/api/fleet/device/${id.deviceId}/inbox`;
    const h = signFleetRequest({ method: 'GET', path, identity: id });
    const r = verifyFleetRequest({
      method: 'POST', // different verb
      path,
      headers: h,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r.ok).toBe(false);
  });

  it('SIG-03: signature does NOT verify under a different path', () => {
    const path = `/api/fleet/device/${id.deviceId}/inbox`;
    const h = signFleetRequest({ method: 'GET', path, identity: id });
    const r = verifyFleetRequest({
      method: 'GET',
      path: `/api/fleet/device/${id.deviceId}/result`, // different path
      headers: h,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r.ok).toBe(false);
  });

  it('SIG-04: missing signature → signature_missing', () => {
    const r = verifyFleetRequest({
      method: 'GET',
      path: '/p',
      headers: {},
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('SIG-05: timestamp outside replay window → ts_outside_window', () => {
    const old = Date.now() - 10 * 60 * 1000;
    const headers = {
      'x-fleet-signature': 'AAAA',
      'x-fleet-timestamp': String(old),
      'x-fleet-device-id': id.deviceId,
    };
    const r = verifyFleetRequest({
      method: 'GET',
      path: '/p',
      headers,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r).toEqual({ ok: false, reason: 'ts_outside_window' });
  });

  it('SIG-06: device id header mismatch → device_id_mismatch', () => {
    const headers = {
      'x-fleet-signature': 'AAAA',
      'x-fleet-timestamp': String(Date.now()),
      'x-fleet-device-id': 'someone-else',
    };
    const r = verifyFleetRequest({
      method: 'GET',
      path: '/p',
      headers,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: id.publicKeyPem,
    });
    expect(r).toEqual({ ok: false, reason: 'device_id_mismatch' });
  });

  it('SIG-07: signature against another device key → bad_signature', () => {
    const other = createDeviceIdentity(path.join(tmp, 'other.json'));
    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    const h = signFleetRequest({ method: 'GET', path: path1, identity: id });
    const r = verifyFleetRequest({
      method: 'GET',
      path: path1,
      headers: h,
      expectedDeviceId: id.deviceId,
      storedPublicKeyPem: other.publicKeyPem, // wrong key
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('SIG-08: fleetRequestSigningInput is canonical (case-normalized verb)', () => {
    const a = fleetRequestSigningInput('GET', '/p', 1, 'd');
    const b = fleetRequestSigningInput('get', '/p', 1, 'd');
    expect(a.toString()).toBe(b.toString());
  });
});
