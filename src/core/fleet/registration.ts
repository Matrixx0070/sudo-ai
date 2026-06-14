/**
 * @file src/core/fleet/registration.ts
 * @description Gap #28c slice 1 — the wire shape of a `POST /api/fleet/register`
 * request and the signature scheme that protects it.
 *
 * **Protocol (slice 1):**
 *  - The device builds a `RegistrationPayload` (deviceId, publicKeyPem,
 *    hostname, version, ts).
 *  - It serializes the payload to canonical JSON (sorted keys, no
 *    insignificant whitespace) so signer + verifier hash the EXACT same bytes.
 *  - It signs that canonical bytes with Ed25519 → base64url signature.
 *  - It POSTs `{ payload, signature }` to the registrar.
 *
 * **Registrar verification (slice 1):**
 *  1. Canonicalize the received payload → bytes.
 *  2. Verify signature against `payload.publicKeyPem`.
 *  3. Check `payload.deviceId == computeDeviceId(payload.publicKeyPem)` —
 *     prevents id-spoofing where a device claims someone else's id with
 *     its own key.
 *  4. Check `|now - payload.ts|  < 300_000ms` — replay window.
 *
 * **Slice-1 weakness** (documented; slice 4 closes): there is no per-attempt
 * nonce challenge. An attacker who captures a valid register request can
 * replay it once before the 5-minute window expires. The on-disk registry
 * uses publicKey as the upsert key, so the replay is idempotent (no
 * spoofed-identity attack), but it could still bump the "last registered"
 * timestamp. Slice 4 adds a `GET /api/fleet/challenge → POST /register`
 * round-trip with a single-use nonce.
 */

import { computeDeviceId, verifySignatureFromPem } from './device-identity.js';

/**
 * Structural shape of the nonce store the verifier needs. Implemented by
 * `NonceStore` in `nonce-store.ts`; declared structurally here so the
 * dashboard route handler (which only sees a runtime global) can pass it
 * through without the concrete class type.
 */
export interface NonceStoreLike {
  consume(deviceId: string, nonce: string): boolean;
}

/** The signed body the device sends to the registrar. */
export interface RegistrationPayload {
  /**
   * Schema version. Slice 4 bumps to 2 — payload now REQUIRES a `nonce`
   * obtained from `GET /api/fleet/challenge`. Version-1 payloads are
   * rejected by `verifyRegistrationRequest` with reason
   * `unsupported_payload_version` so the registrar refuses old clients
   * that don't do the challenge round-trip (replay-window hardening).
   */
  version: 2;
  /** SHA-256-derived id (matches the publicKey). */
  deviceId: string;
  /** Ed25519 SPKI PEM. The registrar uses this to verify the signature. */
  publicKeyPem: string;
  /** OS hostname at register time — useful for the admin to disambiguate. */
  hostname: string;
  /** sudo-ai version string at register time (from package.json). */
  version_str: string;
  /** Unix ms timestamp at register time. Replay-window-checked by registrar. */
  ts: number;
  /**
   * Single-use nonce from `GET /api/fleet/challenge`. Registrar's
   * `NonceStore.consume()` removes it on first valid registration —
   * a captured payload cannot be replayed (slice 4 hardening).
   */
  nonce: string;
  /**
   * Free-form metadata bag — slice 1 stores it verbatim, slice 3's admin
   * UI surfaces it. Required to be a flat string→string map (registrar
   * coerces non-strings to JSON for storage).
   */
  metadata?: Record<string, string>;
}

/** Envelope over the registration POST body. */
export interface RegistrationRequestBody {
  payload: RegistrationPayload;
  signature: string;
}

/**
 * Canonicalize a payload to deterministic JSON. Both sides MUST use this
 * function or signatures will not verify. We sort keys + use no insignificant
 * whitespace + force UTF-8 encoding.
 *
 * Deliberately NOT using `JSON.stringify(payload)` — V8's stringify happens
 * to preserve insertion order today, but that's an impl detail and a
 * different JS engine (or a different fielded order on the wire after
 * proxy round-trip) would break verification.
 */
export function canonicalizePayload(payload: RegistrationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), 'utf8');
}

/** Recursive canonical JSON — sort object keys; leave arrays in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(',')}}`;
}

/** Result tier returned by `verifyRegistrationRequest`. */
export type RegistrationVerifyResult =
  | { ok: true; payload: RegistrationPayload }
  | { ok: false; reason: string };

/**
 * Verify an incoming registration request envelope. Returns a structural
 * result — callers turn the `reason` into an audit log entry + HTTP 400.
 *
 * Replay window: 5 minutes either side of `now`. Larger window = more
 * attacker time; smaller = legitimate NTP drift breaks registration.
 *
 * **Slice-4 hardening — nonce check.** The payload now carries a `nonce`
 * obtained from `GET /api/fleet/challenge`. We consume it atomically from
 * the `NonceStore` AFTER the signature + deviceId checks pass. Replay of
 * a captured valid registration finds no nonce on the second attempt and
 * is rejected with `nonce_consumed_or_unknown`.
 */
export function verifyRegistrationRequest(
  body: unknown,
  opts: {
    nonceStore: NonceStoreLike;
    now?: number;
    replayWindowMs?: number;
  },
): RegistrationVerifyResult {
  const now = opts.now ?? Date.now();
  const replayWindowMs = opts.replayWindowMs ?? 5 * 60 * 1000;
  // Shape check first; rejects malformed bodies in one place.
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body_not_object' };
  const env = body as Partial<RegistrationRequestBody>;
  if (!env.payload || typeof env.payload !== 'object') return { ok: false, reason: 'payload_missing' };
  if (typeof env.signature !== 'string' || env.signature.length === 0) return { ok: false, reason: 'signature_missing' };
  const p = env.payload as Partial<RegistrationPayload>;
  if (p.version !== 2) return { ok: false, reason: 'unsupported_payload_version' };
  if (typeof p.deviceId !== 'string' || p.deviceId.length === 0) return { ok: false, reason: 'deviceId_missing' };
  if (typeof p.publicKeyPem !== 'string' || p.publicKeyPem.length === 0) return { ok: false, reason: 'publicKey_missing' };
  if (typeof p.hostname !== 'string') return { ok: false, reason: 'hostname_missing' };
  if (typeof p.version_str !== 'string') return { ok: false, reason: 'version_str_missing' };
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return { ok: false, reason: 'ts_invalid' };
  if (typeof p.nonce !== 'string' || p.nonce.length === 0) return { ok: false, reason: 'nonce_missing' };

  // Signature first (cheapest way to reject completely random/forged POSTs).
  const canonical = canonicalizePayload(p as RegistrationPayload);
  if (!verifySignatureFromPem(p.publicKeyPem, canonical, env.signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // deviceId must be the deterministic hash of the publicKey — otherwise
  // a device could claim any id while signing with its own key.
  const expectedId = computeDeviceId(p.publicKeyPem);
  if (expectedId !== p.deviceId) return { ok: false, reason: 'deviceId_mismatch' };

  // Replay window check.
  if (Math.abs(now - p.ts) > replayWindowMs) {
    return { ok: false, reason: 'ts_outside_window' };
  }

  // Nonce consume — slice 4. Ordered LAST so we don't burn a nonce on a
  // request that would have been rejected for any other reason. Atomic:
  // consume() removes the entry on first match so a replay finds nothing.
  if (!opts.nonceStore.consume(p.deviceId, p.nonce)) {
    return { ok: false, reason: 'nonce_consumed_or_unknown' };
  }

  return { ok: true, payload: p as RegistrationPayload };
}
