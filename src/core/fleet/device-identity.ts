/**
 * @file src/core/fleet/device-identity.ts
 * @description Gap #28c slice 1 — every sudo-ai instance has a stable
 * cryptographic identity so the central registrar can distinguish devices
 * and verify the holder of the keypair is the one talking.
 *
 * Ed25519 was chosen because:
 *  - Node built-in (`crypto.generateKeyPairSync('ed25519')`), no new deps.
 *  - Signature size is 64 bytes (compact for HTTP headers).
 *  - Sign + verify are constant-time + deterministic; no nonce reuse risk.
 *  - The same key shape will be reused for slice-4 mutual-token handshakes.
 *
 * Persistence shape: a single JSON file at `DATA_DIR/device-identity.json`
 * with mode 0600. Private key as PKCS#8 PEM, public key as SPKI PEM, plus
 * the derived `deviceId` (first 16 hex chars of SHA-256(publicKey raw bytes))
 * stored alongside for fast lookup. The deviceId is DETERMINISTIC from the
 * public key — slice 2's back-channel can recompute it from the key alone,
 * which prevents id-spoofing where a device claims someone else's id.
 *
 * Idempotency: `loadOrCreateDeviceIdentity()` returns the existing identity
 * if the file is present + parses + the deviceId-from-publickey check passes.
 * If the file is present but TAMPERED (deviceId doesn't match key), it
 * refuses to load — better to fail loud than silently use a forged file.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** On-disk shape of `device-identity.json`. */
export interface PersistedDeviceIdentity {
  /** Version tag for future schema changes. Slice 1 = 1. */
  version: 1;
  /** Hex-encoded first 16 chars of SHA-256(publicKey raw bytes). */
  deviceId: string;
  /** Ed25519 public key, SPKI PEM. */
  publicKeyPem: string;
  /** Ed25519 private key, PKCS#8 PEM. NEVER leaves the file. */
  privateKeyPem: string;
  /** ISO-8601 timestamp of identity creation. */
  createdAt: string;
}

/** In-memory device identity with sign/verify operations. */
export interface DeviceIdentity {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  /** Public key SPKI PEM as a string — what the registrar receives. */
  readonly publicKey: string;
  /** Sign an arbitrary byte payload. Returns base64url-encoded signature. */
  sign(payload: Buffer | string): string;
  /** Verify a signature MADE BY THIS DEVICE against a payload. */
  verifyOwn(payload: Buffer | string, signatureB64Url: string): boolean;
}

/** Default file path under DATA_DIR. */
export function defaultIdentityPath(dataDir: string): string {
  return path.join(dataDir, 'device-identity.json');
}

/**
 * Compute the deterministic deviceId from a public-key SPKI PEM.
 *
 * The raw-key-bytes hash (NOT the PEM string hash) is used so the id is
 * stable across PEM-format variations (newline differences, header
 * capitalization). Same key → same id, always.
 */
export function computeDeviceId(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  // export the raw key bytes (no envelope) for the hash input.
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Verify a signature made by an Ed25519 public key (PEM). This is the
 * inverse the registrar uses on incoming `POST /api/fleet/register`.
 *
 * Returns `false` on ANY error (malformed key, malformed signature, bad
 * base64) so the registrar can collapse "couldn't even verify" to a denial
 * without branching on the failure mode.
 */
export function verifySignatureFromPem(
  publicKeyPem: string,
  payload: Buffer | string,
  signatureB64Url: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const sig = base64UrlDecode(signatureB64Url);
    // Ed25519 in node: algorithm parameter MUST be `null`.
    return cryptoVerify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Generate + persist a fresh device identity at `filePath`. Caller is
 * expected to have ensured the parent directory exists.
 */
export function createDeviceIdentity(filePath: string): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = computeDeviceId(publicKeyPem);
  const persisted: PersistedDeviceIdentity = {
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAt: new Date().toISOString(),
  };

  // Atomic-ish: write to .tmp then rename. fs.rename is atomic on POSIX.
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  try {
    chmodSync(tmp, 0o600);
  } catch { /* best-effort on platforms without POSIX permissions */ }
  // rename overwrites destination atomically on POSIX.
  renameSync(tmp, filePath);

  return inMemoryFromPersisted(persisted, privateKey);
}

/**
 * Load an existing identity from disk; throw on corruption or tamper
 * (deviceId/publicKey mismatch). Callers that want fallback-to-create
 * should use `loadOrCreateDeviceIdentity`.
 */
export function loadDeviceIdentity(filePath: string): DeviceIdentity {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as PersistedDeviceIdentity;
  if (parsed.version !== 1) {
    throw new Error(`device-identity.json version ${parsed.version} not supported (expected 1)`);
  }
  if (typeof parsed.publicKeyPem !== 'string' || typeof parsed.privateKeyPem !== 'string' || typeof parsed.deviceId !== 'string') {
    throw new Error('device-identity.json missing required fields');
  }
  // Tamper check: deviceId MUST be derivable from publicKeyPem. If someone
  // hand-edited the file to claim a different id, refuse to load.
  const expected = computeDeviceId(parsed.publicKeyPem);
  if (expected !== parsed.deviceId) {
    throw new Error(`device-identity.json tampered: deviceId=${parsed.deviceId} does not match publicKey-derived id=${expected}`);
  }
  const privateKey = createPrivateKey(parsed.privateKeyPem);
  return inMemoryFromPersisted(parsed, privateKey);
}

/**
 * The boot-time entry: read the identity file or create one if missing.
 * Throws ONLY on file-present-but-corrupt; missing file is the happy "first
 * boot" path.
 */
export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  // Ensure parent dir exists (DATA_DIR is usually created upstream but for
  // tests + first-time installs we should not need a separate mkdir step).
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    return loadDeviceIdentity(filePath);
  }
  return createDeviceIdentity(filePath);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function inMemoryFromPersisted(persisted: PersistedDeviceIdentity, privateKey: KeyObject): DeviceIdentity {
  return {
    deviceId: persisted.deviceId,
    publicKeyPem: persisted.publicKeyPem,
    publicKey: persisted.publicKeyPem,
    sign(payload) {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
      const sig = cryptoSign(null, data, privateKey);
      return base64UrlEncode(sig);
    },
    verifyOwn(payload, signatureB64Url) {
      return verifySignatureFromPem(persisted.publicKeyPem, payload, signatureB64Url);
    },
  };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padLen), 'base64');
}
