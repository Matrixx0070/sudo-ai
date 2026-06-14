/**
 * @file tests/fleet/registration.test.ts
 * @description Gap #28c — registration envelope verify. Updated for slice 4:
 * the verifier now requires a `nonceStore` option and the payload carries
 * `version: 2` + a `nonce` issued by the registrar.
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
import { NonceStore } from '../../src/core/fleet/nonce-store.js';

let tmp: string;
let id: DeviceIdentity;
let nonceStore: NonceStore;

function signedBody(payload: RegistrationPayload, identity: DeviceIdentity = id): RegistrationRequestBody {
  return { payload, signature: identity.sign(canonicalizePayload(payload)) };
}

/** Issue a fresh nonce for `id` and return a payload + signed envelope. */
function freshPayload(overrides: Partial<RegistrationPayload> = {}, identity: DeviceIdentity = id): RegistrationPayload {
  const nonce = nonceStore.issue(identity.deviceId).nonce;
  return {
    version: 2,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    hostname: 'test-host',
    version_str: '4.1.0',
    ts: Date.now(),
    nonce,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-reg-'));
  id = createDeviceIdentity(defaultIdentityPath(tmp));
  nonceStore = new NonceStore();
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('verifyRegistrationRequest', () => {
  it('REG-01: well-formed body → ok', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload()), { nonceStore });
    expect(r.ok).toBe(true);
  });

  it('REG-02: body not an object → body_not_object', () => {
    expect(verifyRegistrationRequest(null, { nonceStore })).toEqual({ ok: false, reason: 'body_not_object' });
    expect(verifyRegistrationRequest('string', { nonceStore })).toEqual({ ok: false, reason: 'body_not_object' });
  });

  it('REG-03: missing signature → signature_missing', () => {
    const body = { payload: freshPayload() } as unknown;
    expect(verifyRegistrationRequest(body, { nonceStore })).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('REG-04: missing payload → payload_missing', () => {
    expect(verifyRegistrationRequest({ signature: 'x' }, { nonceStore })).toEqual({ ok: false, reason: 'payload_missing' });
  });

  it('REG-05: unsupported version → unsupported_payload_version', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ version: 99 as unknown as 2 })), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'unsupported_payload_version' });
  });

  it('REG-05b: legacy version 1 payload → unsupported_payload_version (slice-4 hardening)', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ version: 1 as unknown as 2 })), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'unsupported_payload_version' });
  });

  it('REG-06: deviceId missing → deviceId_missing', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ deviceId: '' })), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'deviceId_missing' });
  });

  it('REG-07: publicKey missing → publicKey_missing', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ publicKeyPem: '' })), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'publicKey_missing' });
  });

  it('REG-07b: nonce missing → nonce_missing', () => {
    const p = freshPayload();
    delete (p as { nonce?: string }).nonce;
    const r = verifyRegistrationRequest(signedBody(p), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'nonce_missing' });
  });

  it('REG-08: signature does not verify → bad_signature', () => {
    const body = signedBody(freshPayload());
    body.signature = 'AAAA';
    expect(verifyRegistrationRequest(body, { nonceStore })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('REG-09: deviceId does not match publicKey → deviceId_mismatch', () => {
    const other = createDeviceIdentity(path.join(tmp, 'other.json'));
    const nonce = nonceStore.issue(other.deviceId).nonce; // pretend other got a nonce
    const payload: RegistrationPayload = {
      version: 2,
      deviceId: other.deviceId, // wrong
      publicKeyPem: id.publicKeyPem, // first's pubkey
      hostname: 'test-host',
      version_str: '4.1.0',
      ts: Date.now(),
      nonce,
    };
    const body = { payload, signature: id.sign(canonicalizePayload(payload)) };
    expect(verifyRegistrationRequest(body, { nonceStore })).toEqual({ ok: false, reason: 'deviceId_mismatch' });
  });

  it('REG-10: timestamp outside replay window → ts_outside_window', () => {
    const tooOld = Date.now() - 10 * 60 * 1000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: tooOld })), { nonceStore });
    expect(r).toEqual({ ok: false, reason: 'ts_outside_window' });
  });

  it('REG-11: timestamp slightly skewed (within window) → ok', () => {
    const slightlyAhead = Date.now() + 30_000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: slightlyAhead })), { nonceStore });
    expect(r.ok).toBe(true);
  });

  it('REG-12: replay window override accepts older ts when widened', () => {
    const tooOld = Date.now() - 30 * 60 * 1000;
    const r = verifyRegistrationRequest(signedBody(freshPayload({ ts: tooOld })), { nonceStore, replayWindowMs: 60 * 60 * 1000 });
    expect(r.ok).toBe(true);
  });

  it('REG-13: canonicalizePayload sorts keys (signer + verifier agree)', () => {
    const a: RegistrationPayload = {
      version: 2,
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'h',
      version_str: '1',
      ts: 123,
      nonce: 'n',
    };
    const b: RegistrationPayload = {
      nonce: 'n',
      ts: 123,
      hostname: 'h',
      version_str: '1',
      publicKeyPem: id.publicKeyPem,
      deviceId: id.deviceId,
      version: 2,
    };
    expect(canonicalizePayload(a).toString()).toBe(canonicalizePayload(b).toString());
  });

  it('REG-14: metadata field round-trips through verify', () => {
    const r = verifyRegistrationRequest(signedBody(freshPayload({ metadata: { region: 'us-east-1', role: 'edge' } })), { nonceStore });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.metadata).toEqual({ region: 'us-east-1', role: 'edge' });
    }
  });

  it('REG-15: nonce_consumed_or_unknown — replay of a captured registration rejected', () => {
    const body = signedBody(freshPayload());
    const first = verifyRegistrationRequest(body, { nonceStore });
    expect(first.ok).toBe(true);
    // Same body, second time — nonce already consumed.
    const second = verifyRegistrationRequest(body, { nonceStore });
    expect(second).toEqual({ ok: false, reason: 'nonce_consumed_or_unknown' });
  });

  it('REG-16: unknown nonce (never issued) → nonce_consumed_or_unknown', () => {
    const body = signedBody(freshPayload({ nonce: 'never-issued-nonce' }));
    expect(verifyRegistrationRequest(body, { nonceStore })).toEqual({ ok: false, reason: 'nonce_consumed_or_unknown' });
  });
});
