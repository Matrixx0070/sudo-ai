/**
 * @file src/core/fleet/fleet-signature.ts
 * @description Gap #28c slice 2 — per-request signature scheme for the
 * device→registrar back-channel.
 *
 * Slice 1 used Ed25519 only at registration time. Slice 2 needs the same
 * device to prove possession of its private key on EVERY inbox/result
 * request — otherwise anyone who learned a device's deviceId could pull
 * its commands or POST forged results.
 *
 * **Wire shape:**
 *   - Header `X-Fleet-Signature: <base64url-signature>`
 *   - Header `X-Fleet-Timestamp: <unix-ms>`
 *   - Signed bytes: canonical UTF-8 of `<METHOD>\n<PATH>\n<TIMESTAMP>\n<DEVICE_ID>`
 *
 * The registrar reads `:deviceId` from the URL path, looks up the device's
 * public key in the registry, and verifies the signature. Timestamp must
 * be within ±5 min of the registrar's clock (replay window matching
 * registration).
 *
 * **Why include METHOD + PATH in the signed bytes?**
 *   Without them, a captured signature for `GET .../inbox?wait=30s` could
 *   be reused on `POST .../result` with an attacker-chosen body. Including
 *   the verb + path binds the signature to the specific request.
 *
 * **Why NOT include the body?**
 *   Slice 2 only protects route AUTH — the body is parsed + validated
 *   downstream. Including the body would require streaming-then-buffering
 *   on the registrar side (already do that via readJsonBody) but doesn't
 *   close any attack vector for our slice-2 commands. Slice 4 may revisit
 *   if we add high-impact admin commands.
 */

import { verifySignatureFromPem, type DeviceIdentity } from './device-identity.js';

/** Canonical bytes a device signs for a back-channel HTTP request. */
export function fleetRequestSigningInput(method: string, path: string, timestampMs: number, deviceId: string): Buffer {
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${timestampMs}\n${deviceId}`, 'utf8');
}

/** Build the headers a device should send for an inbox/result request. */
export function signFleetRequest(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  identity: DeviceIdentity;
  now?: () => number;
}): { 'X-Fleet-Signature': string; 'X-Fleet-Timestamp': string; 'X-Fleet-Device-Id': string } {
  const now = (opts.now ?? Date.now)();
  const data = fleetRequestSigningInput(opts.method, opts.path, now, opts.identity.deviceId);
  const sig = opts.identity.sign(data);
  return {
    'X-Fleet-Signature': sig,
    'X-Fleet-Timestamp': String(now),
    'X-Fleet-Device-Id': opts.identity.deviceId,
  };
}

/** Result tier returned by `verifyFleetRequest`. */
export type FleetVerifyResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: string };

/**
 * Verify a fleet back-channel request. Used by the registrar's
 * inbox/result handlers. Receives the device's stored public key (looked
 * up by deviceId from the path).
 *
 * Slice 2 path policy: the `:deviceId` URL segment must match the
 * `X-Fleet-Device-Id` header — otherwise a device that learned ANOTHER
 * device's id could try requests under that id while still signing with
 * its own key. The URL-segment id is the authoritative one for lookup,
 * but the redundant header check makes signing-vs-lookup mismatches a
 * structural error instead of a silent "wrong key" failure.
 */
export function verifyFleetRequest(opts: {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  expectedDeviceId: string;
  storedPublicKeyPem: string;
  now?: number;
  replayWindowMs?: number;
}): FleetVerifyResult {
  const sig = headerOne(opts.headers, 'x-fleet-signature');
  const tsRaw = headerOne(opts.headers, 'x-fleet-timestamp');
  const devRaw = headerOne(opts.headers, 'x-fleet-device-id');
  if (!sig) return { ok: false, reason: 'signature_missing' };
  if (!tsRaw) return { ok: false, reason: 'timestamp_missing' };
  if (!devRaw) return { ok: false, reason: 'device_id_header_missing' };

  if (devRaw !== opts.expectedDeviceId) return { ok: false, reason: 'device_id_mismatch' };

  const ts = parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp_invalid' };

  const now = opts.now ?? Date.now();
  const window = opts.replayWindowMs ?? 5 * 60 * 1000;
  if (Math.abs(now - ts) > window) return { ok: false, reason: 'ts_outside_window' };

  const data = fleetRequestSigningInput(opts.method, opts.path, ts, opts.expectedDeviceId);
  if (!verifySignatureFromPem(opts.storedPublicKeyPem, data, sig)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, deviceId: opts.expectedDeviceId };
}

function headerOne(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  // Case-insensitive scan: node:http already lowercases inbound headers, but
  // test harnesses (and `signFleetRequest`'s return value) use camelCase.
  // Iterate once instead of brittle name-variant lookups.
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
