/**
 * @file tests/fleet/registration.test.ts
 * @description Gap #28c slice 1 — registration envelope verify.
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
  canonicalizePayload,
  verifyRegistrationRequest,
  type RegistrationPayload,
  type RegistrationRequestBody,
} from '../../src/core/fleet/registration.js';

let tmp: string;
let id: DeviceIdentity;

function signedBody(payload: RegistrationPayload, identity: DeviceIdentity = id): RegistrationRequestBody {
  return { payload, signature: identity.sign(canonicalizePayload(payload)) };
}

function freshPayload(overrides: Partial<RegistrationPayload> = {}, identity: DeviceIdentity = id): RegistrationPayload {
  return {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    hostname: 'test-host',
    version_str: '4.1.0',
    ts: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-reg-'));
  id = createDeviceIdentity(defaultIdentityPath(tmp));
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('verifyRegistrationRequest', () => {
  it('REG-01: well-formed body → ok', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload()));
    expect(r.ok).toBe(true);
  });

  it('REG-02: body not an object → body_not_object', () => {
    expect(verifyRegistrationRequest(null)).toEqual({ ok: false, reason: 'body_not_object' });
    expect(verifyRegistrationRequest('string')).toEqual({ ok: false, reason: 'body_not_object' });
  });

  it('REG-03: missing signature → signature_missing', () => {
    const body = { payload: freshPayload() } as unknown;
    expect(verifyRegistrationRequest(body)).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('REG-04: missing payload → payload_missing', () => {
    expect(verifyRegistrationRequest({ signature: 'x' })).toEqual({ ok: false, reason: 'payload_missing' });
  });

  it('REG-05: unsupported version → unsupported_payload_version', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ version: 99 as unknown as 1 })));
    expect(r).toEqual({ ok: false, reason: 'unsupported_payload_version' });
  });

  it('REG-06: deviceId missing → deviceId_missing', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ deviceId: '' })));
    expect(r).toEqual({ ok: false, reason: 'deviceId_missing' });
  });

  it('REG-07: publicKey missing → publicKey_missing', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ publicKeyPem: '' })));
    expect(r).toEqual({ ok: false, reason: 'publicKey_missing' });
  });

  it('REG-08: signature does not verify → bad_signature', () => {
    const body = signedBody(freshPayload());
    body.signature = 'AAAA'; // wrong sig, but base64-valid
    expect(verifyRegistrationRequest(body)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('REG-09: deviceId does not match publicKey → deviceId_mismatch', () => {
    // Build a second identity, then use first.publicKey but second.deviceId.
    const other = createDeviceIdentity(path.join(tmp, 'other.json'));
    const payload = freshPayload({
      deviceId: other.deviceId, // wrong
      publicKeyPem: id.publicKeyPem, // first's pubkey
    });
    // Sign with first's private key — signature verifies fine; deviceId is the spoof.
    const body = { payload, signature: id.sign(canonicalizePayload(payload)) };
    expect(verifyRegistrationRequest(body)).toEqual({ ok: false, reason: 'deviceId_mismatch' });
  });

  it('REG-10: timestamp outside replay window → ts_outside_window', () => {
    const tooOld = Date.now() - 10 * 60 * 1000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: tooOld })));
    expect(r).toEqual({ ok: false, reason: 'ts_outside_window' });
  });

  it('REG-11: timestamp slightly skewed (within window) → ok', () => {
    const slightlyAhead = Date.now() + 30_000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: slightlyAhead })));
    expect(r.ok).toBe(true);
  });

  it('REG-12: replay window override accepts older ts when widened', () => {
    const tooOld = Date.now() - 30 * 60 * 1000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: tooOld })), Date.now(), 60 * 60 * 1000);
    expect(r.ok).toBe(true);
  });

  it('REG-13: canonicalizePayload sorts keys (signer + verifier agree)', () => {
    // Build the same logical payload two ways; canonical bytes must match.
    const a: RegistrationPayload = {
      version: 1,
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'h',
      version_str: '1',
      ts: 123,
    };
    const b: RegistrationPayload = {
      ts: 123,
      hostname: 'h',
      version_str: '1',
      publicKeyPem: id.publicKeyPem,
      deviceId: id.deviceId,
      version: 1,
    };
    expect(canonicalizePayload(a).toString()).toBe(canonicalizePayload(b).toString());
  });

  it('REG-14: metadata field round-trips through verify', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ metadata: { region: 'us-east-1', role: 'edge' } })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.metadata).toEqual({ region: 'us-east-1', role: 'edge' });
    }
  });
});
