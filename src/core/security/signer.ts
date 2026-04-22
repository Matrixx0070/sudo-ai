/**
 * @file security/signer.ts
 * @description ed25519 artifact signing and verification for SUDO-AI Wave 10G.
 *
 * Key rotation support:
 *  - Active private keys stored at data/keys/wave10-signer-v{N}.priv (0600).
 *  - Public keys and metadata persisted in KeyRotationStore (SQLite).
 *  - Legacy wave10-signer.{pub,priv} promoted to v1 on first use after Wave 10G deploy.
 *  - rotate() generates a new keypair, retires the previous key (24h window by default).
 *  - verify() accepts artifacts from active or retiring keys (dual-verify window).
 *
 * Kill-switches (all exact === '1' semantics):
 *  - SUDO_SIGNING_DISABLE=1   → sign() returns a placeholder, verify() returns valid:false.
 *  - SUDO_KEY_ROTATION_DISABLE=1 → rotate() throws (caller/admin-route maps to 503).
 *  - SUDO_DUAL_VERIFY_DISABLE=1  → verify() hard-fails on non-active key.
 *
 * Env overrides:
 *  - SUDO_SIGNER_KEY_DIR          → directory for key files (default: data/keys).
 *  - SUDO_KEY_ROTATION_DB_PATH    → SQLite path (default: data/keys/key-rotation.db).
 *  - SUDO_KEY_ROTATION_MIN_INTERVAL_MS → idempotency window in ms (default: 60000).
 *
 * @module security/signer
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { SignedArtifact, ArtifactVerifyResult } from '../shared/wave10-types.js';
import { KeyRotationStore, type KeyRotationRow } from './key-rotation-store.js';

const log = createLogger('security:signer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETIREMENT_WINDOW_HOURS = 24;
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const MAX_KEYGEN_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Key path helpers (lazy — read from env on every call for test isolation)
// ---------------------------------------------------------------------------

function getKeyDir(): string {
  return process.env['SUDO_SIGNER_KEY_DIR'] ?? path.resolve('data', 'keys');
}

/** Path for versioned private key file. */
function getVersionedPrivPath(keyVersion: number): string {
  return path.join(getKeyDir(), `wave10-signer-v${keyVersion}.priv`);
}

/** Path for versioned public key file. */
function getVersionedPubPath(keyVersion: number): string {
  return path.join(getKeyDir(), `wave10-signer-v${keyVersion}.pub`);
}

/** Legacy (pre-10G) public key path. */
function getLegacyPubPath(): string {
  return path.join(getKeyDir(), 'wave10-signer.pub');
}

/** Legacy (pre-10G) private key path. */
function getLegacyPrivPath(): string {
  return path.join(getKeyDir(), 'wave10-signer.priv');
}

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

interface GeneratedKeypair {
  publicKeyDerHex: string;
  privateKeyDerHex: string;
  keyId: string;
}

function generateKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const pubHex = (publicKey as Buffer).toString('hex');
  const privHex = (privateKey as Buffer).toString('hex');
  const keyId = pubHex.slice(24, 32);

  return { publicKeyDerHex: pubHex, privateKeyDerHex: privHex, keyId };
}

/** Ensure key directory exists with 0700 permissions. */
function ensureKeyDir(): void {
  const keyDir = getKeyDir();
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
}

/** Write private key file with strict 0600 permissions. */
function writePrivKeyFile(privPath: string, privHex: string): void {
  fs.writeFileSync(privPath, privHex, { encoding: 'utf8', mode: 0o600 });
  // Enforce 0600 even if umask is permissive.
  try { fs.chmodSync(privPath, 0o600); } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Sign input construction
// ---------------------------------------------------------------------------

function buildSignInput(payload: unknown, signedAt: string): Buffer {
  return Buffer.from(JSON.stringify(payload) + signedAt, 'utf8');
}

// ---------------------------------------------------------------------------
// ArtifactSigner class
// ---------------------------------------------------------------------------

/**
 * Signs and verifies JSON payloads using ed25519 keypairs.
 *
 * Supports key rotation: active private key is version-indexed, verified
 * against KeyRotationStore (SQLite). In-process cache is keyed by keyVersion
 * so post-rotate sign() calls use the new key without restart.
 */
export class ArtifactSigner {
  private readonly _store: KeyRotationStore;

  /**
   * Cache: keyVersion → { privateKeyDerHex }.
   * Public key is NOT cached — always read from DB (source of truth).
   */
  private readonly _keysCache: Map<number, { privateKeyDerHex: string }> = new Map();

  constructor() {
    this._store = new KeyRotationStore();
    this._migrateLegacyIfNeeded();
  }

  // ---------------------------------------------------------------------------
  // Legacy migration (runs at construction if legacy files exist and DB is empty)
  // ---------------------------------------------------------------------------

  private _migrateLegacyIfNeeded(): void {
    try {
      if (this._store.getActive() !== null) {
        // DB already has rows — migration already done or clean install already seeded.
        return;
      }

      const legacyPub = getLegacyPubPath();
      const legacyPriv = getLegacyPrivPath();
      if (!fs.existsSync(legacyPub) || !fs.existsSync(legacyPriv)) {
        // No legacy files — fresh install, auto-seed deferred to sign().
        return;
      }

      log.info({}, 'ArtifactSigner: promoting legacy wave10-signer.{pub,priv} to v1');

      const pubHex = fs.readFileSync(legacyPub, 'utf8').trim();
      const privHex = fs.readFileSync(legacyPriv, 'utf8').trim();

      ensureKeyDir();

      // Copy legacy files to versioned names (do NOT move — rollback safety).
      const v1Pub = getVersionedPubPath(1);
      const v1Priv = getVersionedPrivPath(1);

      if (!fs.existsSync(v1Pub)) {
        fs.writeFileSync(v1Pub, pubHex, { encoding: 'utf8', mode: 0o644 });
      }
      if (!fs.existsSync(v1Priv)) {
        writePrivKeyFile(v1Priv, privHex);
      }

      // Derive mtime from legacy pub file for generated_at.
      let generatedAt: string;
      try {
        generatedAt = fs.statSync(legacyPub).mtime.toISOString();
      } catch {
        generatedAt = new Date().toISOString();
      }

      this._store.promoteLegacy({
        key_id: pubHex.slice(0, 8),
        public_key: pubHex,
        algorithm: 'ed25519',
        status: 'active',
        generated_at: generatedAt,
        retired_at: null,
      });

      log.info({ keyId: pubHex.slice(0, 8) }, 'ArtifactSigner: legacy key promoted to v1');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'ArtifactSigner: legacy migration failed (will auto-seed on first sign)');
      // Non-fatal — sign() auto-seeds fresh v1 if needed.
    }
  }

  // ---------------------------------------------------------------------------
  // _autoSeedIfEmpty — generate fresh v1 when no legacy files and empty DB
  // ---------------------------------------------------------------------------

  private _autoSeedIfEmpty(): void {
    if (this._store.getActive() !== null) return;

    log.info({}, 'ArtifactSigner: auto-seeding fresh ed25519 v1 keypair');

    ensureKeyDir();
    let kp: GeneratedKeypair | null = null;

    for (let attempt = 0; attempt < MAX_KEYGEN_ATTEMPTS; attempt++) {
      kp = generateKeypair();
      // Check for key_id collision (extremely rare).
      if (!this._store.getByKeyId(kp.keyId)) break;
      kp = null;
    }

    if (!kp) throw new Error('ArtifactSigner: failed to generate unique keypair after 3 attempts');

    const generatedAt = new Date().toISOString();
    const v1Pub = getVersionedPubPath(1);
    const v1Priv = getVersionedPrivPath(1);

    fs.writeFileSync(v1Pub, kp.publicKeyDerHex, { encoding: 'utf8', mode: 0o644 });
    writePrivKeyFile(v1Priv, kp.privateKeyDerHex);

    this._store.promoteLegacy({
      key_id: kp.keyId,
      public_key: kp.publicKeyDerHex,
      algorithm: 'ed25519',
      status: 'active',
      generated_at: generatedAt,
      retired_at: null,
    });

    log.info({ keyId: kp.keyId }, 'ArtifactSigner: fresh v1 keypair auto-seeded');
  }

  // ---------------------------------------------------------------------------
  // _loadPrivKey — load private key from disk into cache
  // ---------------------------------------------------------------------------

  private _loadPrivKey(keyVersion: number): string {
    if (this._keysCache.has(keyVersion)) {
      return this._keysCache.get(keyVersion)!.privateKeyDerHex;
    }

    const privPath = getVersionedPrivPath(keyVersion);
    let privHex: string;
    try {
      privHex = fs.readFileSync(privPath, 'utf8').trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ArtifactSigner: cannot read private key v${keyVersion} at ${privPath}: ${msg}`);
    }

    this._keysCache.set(keyVersion, { privateKeyDerHex: privHex });
    return privHex;
  }

  // ---------------------------------------------------------------------------
  // sign
  // ---------------------------------------------------------------------------

  /**
   * Sign an arbitrary JSON-serializable payload.
   *
   * Step 0: auto-seed if DB is empty (fresh install).
   * Step 1: query active row from DB.
   * Step 2: load priv key (cache by version).
   * Step 3: sign and return artifact with keyVersion.
   *
   * Kill-switch: SUDO_SIGNING_DISABLE=1 → returns placeholder with empty signature.
   */
  sign(
    payload: unknown,
    artifactType: SignedArtifact['artifactType'],
  ): SignedArtifact {
    if (process.env['SUDO_SIGNING_DISABLE'] === '1') {
      log.debug({ artifactType }, 'SUDO_SIGNING_DISABLE: skipping signing');
      return {
        payload,
        signedAt: new Date().toISOString(),
        keyId: 'disabled',
        keyVersion: 0,
        signature: '',
        artifactType,
      };
    }

    // Step 0: auto-seed if empty.
    this._autoSeedIfEmpty();

    // Step 1: get active row (guaranteed non-null after step 0).
    const activeRow = this._store.getActive();
    if (!activeRow) throw new Error('ArtifactSigner.sign: no active key after auto-seed (invariant broken)');

    const { key_version: keyVersion, key_id: keyId, public_key: publicKeyDerHex } = activeRow;

    // Step 2: load private key (cache miss → read from disk).
    const privateKeyDerHex = this._loadPrivKey(keyVersion);

    // Step 3: sign.
    const signedAt = new Date().toISOString();
    const input = buildSignInput(payload, signedAt);

    const privKey = crypto.createPrivateKey({
      key: Buffer.from(privateKeyDerHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto.sign(null, input, privKey).toString('hex');

    log.debug({ keyId, keyVersion, artifactType }, 'Artifact signed');

    // Suppress unused variable lint warning — publicKeyDerHex not used in sign path.
    void publicKeyDerHex;

    return {
      payload,
      signedAt,
      keyId,
      keyVersion,
      signature,
      artifactType,
    };
  }

  // ---------------------------------------------------------------------------
  // verify
  // ---------------------------------------------------------------------------

  /**
   * Verify a SignedArtifact.
   *
   * Supports:
   *  - Artifacts from Wave 10G+ with keyVersion field (lookup by version).
   *  - Artifacts from Wave 10F without keyVersion (fallback to keyId lookup).
   *
   * Kill-switch: SUDO_DUAL_VERIFY_DISABLE=1 → reject anything not status='active'.
   */
  verify(artifact: SignedArtifact): ArtifactVerifyResult {
    try {
      if (process.env['SUDO_SIGNING_DISABLE'] === '1') {
        return { valid: false, keyId: artifact.keyId, signedAt: artifact.signedAt, error: 'Signing disabled' };
      }

      // Step 1: look up the key row.
      let row: KeyRotationRow | null = null;

      if (typeof artifact.keyVersion === 'number' && artifact.keyVersion > 0) {
        row = this._store.getByVersion(artifact.keyVersion);
      }

      if (!row) {
        // Backward compat: fall back to keyId lookup (Wave 10F artifacts without keyVersion).
        row = this._store.getByKeyId(artifact.keyId);
      }

      if (!row) {
        return {
          valid: false,
          keyId: artifact.keyId,
          signedAt: artifact.signedAt,
          error: `Key not found: version=${artifact.keyVersion ?? 'n/a'}, keyId=${artifact.keyId}`,
        };
      }

      // Lazily expire retiring rows whose window has passed.
      this._store.expireIfDue(row.key_version);

      // Re-read after potential status update.
      const freshRow = this._store.getByVersion(row.key_version) ?? row;

      // Step 2: kill-switch check — dual-verify disabled → active only.
      if (process.env['SUDO_DUAL_VERIFY_DISABLE'] === '1') {
        if (freshRow.status !== 'active') {
          return {
            valid: false,
            keyId: artifact.keyId,
            signedAt: artifact.signedAt,
            error: `Dual verify disabled: key v${freshRow.key_version} is ${freshRow.status}, not active`,
          };
        }
      }

      // Step 3: accept active or retiring within window; reject retired and expired retiring.
      if (freshRow.status === 'retired') {
        return {
          valid: false,
          keyId: artifact.keyId,
          signedAt: artifact.signedAt,
          error: `Key retired: v${freshRow.key_version}`,
        };
      }

      if (freshRow.status === 'retiring') {
        const retiredAt = freshRow.retired_at ? Date.parse(freshRow.retired_at) : 0;
        if (!freshRow.retired_at || Date.now() >= retiredAt) {
          return {
            valid: false,
            keyId: artifact.keyId,
            signedAt: artifact.signedAt,
            error: `Key retired: v${freshRow.key_version} retirement window has passed`,
          };
        }
      }

      // Step 4: verify signature using public_key from DB (never from disk).
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(freshRow.public_key, 'hex'),
        format: 'der',
        type: 'spki',
      });

      const input = buildSignInput(artifact.payload, artifact.signedAt);
      const sigBuffer = Buffer.from(artifact.signature, 'hex');
      const valid = crypto.verify(null, input, pubKey, sigBuffer);

      log.debug({ keyId: freshRow.key_id, keyVersion: freshRow.key_version, valid }, 'Artifact verification result');

      return {
        valid,
        keyId: freshRow.key_id,
        signedAt: artifact.signedAt,
        ...(valid ? {} : { error: 'Signature verification failed' }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Artifact verification threw');
      return {
        valid: false,
        keyId: artifact.keyId,
        signedAt: artifact.signedAt,
        error: `Verification error: ${msg}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // getPublicKey
  // ---------------------------------------------------------------------------

  /**
   * Return public key metadata for GET /v1/admin/public-key.
   * Only exposes public material — never private key data.
   *
   * Includes optional `retiring` sub-object when a retiring key exists within its window.
   */
  getPublicKey(): {
    keyId: string;
    keyVersion: number;
    algorithm: 'ed25519';
    publicKey: string;
    generatedAt?: string;
    retiring?: {
      keyId: string;
      keyVersion: number;
      publicKey: string;
      retiredAt: string;
    };
  } {
    // Auto-seed if needed (e.g., called directly before any sign()).
    this._autoSeedIfEmpty();

    const active = this._store.getActive();
    if (!active) throw new Error('ArtifactSigner.getPublicKey: no active key');

    const result: ReturnType<ArtifactSigner['getPublicKey']> = {
      keyId: active.key_id,
      keyVersion: active.key_version,
      algorithm: 'ed25519',
      publicKey: active.public_key,
      generatedAt: active.generated_at,
    };

    // Include retiring sub-object if a retiring key is still within its window.
    const retiring = this._store.getRetiring();
    if (retiring && retiring.retired_at) {
      result.retiring = {
        keyId: retiring.key_id,
        keyVersion: retiring.key_version,
        publicKey: retiring.public_key,
        retiredAt: retiring.retired_at,
      };
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // verifyWithPublicKey
  // ---------------------------------------------------------------------------

  /**
   * Verify a SignedArtifact using a caller-supplied DER-encoded public key (hex).
   *
   * Intended for federation peer verification where the public key comes from a
   * remote peer's /v1/admin/public-key response rather than the local KeyRotationStore.
   *
   * Does NOT consult KeyRotationStore — the caller is responsible for trusting
   * the supplied public key material.
   *
   * Returns false on any error (malformed hex, invalid key, bad signature, etc.).
   */
  verifyWithPublicKey(artifact: SignedArtifact, publicKeyDerHex: string): boolean {
    try {
      const input = buildSignInput(artifact.payload, artifact.signedAt);
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(publicKeyDerHex, 'hex'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, input, pubKey, Buffer.from(artifact.signature, 'hex'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug({ err: msg }, 'verifyWithPublicKey: verification failed');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // rotate
  // ---------------------------------------------------------------------------

  /**
   * Generate a new ed25519 keypair, promote it to active, retire the previous key.
   *
   * Kill-switch: SUDO_KEY_ROTATION_DISABLE=1 → throws Error (admin-route returns 503).
   * Idempotency: if within SUDO_KEY_ROTATION_MIN_INTERVAL_MS (default 60s), returns
   *   current active key data with idempotent:true (no new key generated).
   *
   * @returns Rotation result with new key metadata and retired key info.
   */
  rotate(): {
    keyId: string;
    keyVersion: number;
    algorithm: 'ed25519';
    generatedAt: string;
    retiredKeyId?: string;
    retiredKeyVersion?: number;
    idempotent: boolean;
  } {
    if (process.env['SUDO_KEY_ROTATION_DISABLE'] === '1') {
      throw new Error('Key rotation is disabled (SUDO_KEY_ROTATION_DISABLE=1)');
    }

    // Auto-seed v1 if no key exists yet.
    this._autoSeedIfEmpty();

    const minIntervalMs = (() => {
      const raw = process.env['SUDO_KEY_ROTATION_MIN_INTERVAL_MS'];
      if (!raw) return DEFAULT_MIN_INTERVAL_MS;
      const n = Number(raw);
      return isNaN(n) ? DEFAULT_MIN_INTERVAL_MS : n;
    })();

    // Advisory pre-check (non-definitive — definitive check is inside BEGIN EXCLUSIVE txn).
    const currentActive = this._store.getActive();
    if (!currentActive) throw new Error('ArtifactSigner.rotate: no active key (invariant broken after auto-seed)');

    ensureKeyDir();

    // Generate new keypair (outside transaction — retries on key_id collision).
    let newKp: GeneratedKeypair | null = null;
    let newPrivPath = '';

    for (let attempt = 0; attempt < MAX_KEYGEN_ATTEMPTS; attempt++) {
      newKp = generateKeypair();
      if (!this._store.getByKeyId(newKp.keyId)) {
        // Write to a unique tmp path before transaction to avoid concurrent callers
        // overwriting each other's key material.  The final rename happens only
        // after the EXCLUSIVE txn commits with a non-idempotent result, using
        // storeResult.key_version so the path is authoritative.
        const tmpSuffix = crypto.randomBytes(8).toString('hex');
        newPrivPath = getVersionedPrivPath(currentActive.key_version + 1) + `.tmp-${tmpSuffix}`;
        writePrivKeyFile(newPrivPath, newKp.privateKeyDerHex);
        break;
      }
      newKp = null;
    }

    if (!newKp) throw new Error('ArtifactSigner.rotate: failed to generate unique keypair after 3 attempts');

    const generatedAt = new Date().toISOString();

    const newRowData: Omit<import('./key-rotation-store.js').KeyRotationRow, 'key_version'> = {
      key_id: newKp.keyId,
      public_key: newKp.publicKeyDerHex,
      algorithm: 'ed25519',
      status: 'active',
      generated_at: generatedAt,
      retired_at: null,
    };

    // Transactional promotion (BEGIN EXCLUSIVE — handles concurrent rotate()).
    let storeResult: import('./key-rotation-store.js').KeyRotationRow & { idempotent: boolean };
    try {
      storeResult = this._store.promoteNewKey(newRowData, RETIREMENT_WINDOW_HOURS, minIntervalMs);
    } catch (err: unknown) {
      // Transaction failed — clean up orphan priv file.
      try { fs.unlinkSync(newPrivPath); } catch { /* best-effort */ }
      throw err;
    }

    if (storeResult.idempotent) {
      // Within idempotency window — new keypair was not needed.
      try { fs.unlinkSync(newPrivPath); } catch { /* best-effort */ }
      log.info({ keyId: storeResult.key_id, keyVersion: storeResult.key_version }, 'ArtifactSigner.rotate: idempotent (within window)');
      return {
        keyId: storeResult.key_id,
        keyVersion: storeResult.key_version,
        algorithm: 'ed25519',
        generatedAt: storeResult.generated_at,
        idempotent: true,
      };
    }

    // Rotation committed — atomically rename tmp file to authoritative versioned path.
    const finalPrivPath = getVersionedPrivPath(storeResult.key_version);
    try {
      fs.renameSync(newPrivPath, finalPrivPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, tmpPath: newPrivPath, finalPath: finalPrivPath }, 'ArtifactSigner.rotate: rename failed after commit (key file missing on disk)');
      throw err;
    }

    // Rotation committed — best-effort delete old private key.
    const oldPrivPath = getVersionedPrivPath(currentActive.key_version);
    try {
      fs.unlinkSync(oldPrivPath);
      log.info({ oldPath: oldPrivPath }, 'ArtifactSigner.rotate: old private key deleted');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, oldPath: oldPrivPath }, 'ArtifactSigner.rotate: failed to delete old private key (non-fatal)');
    }

    // Evict old version from in-process cache.
    this._keysCache.delete(currentActive.key_version);

    log.info(
      { newKeyId: storeResult.key_id, newKeyVersion: storeResult.key_version, retiredKeyId: currentActive.key_id, retiredKeyVersion: currentActive.key_version },
      'ArtifactSigner.rotate: key rotated successfully',
    );

    return {
      keyId: storeResult.key_id,
      keyVersion: storeResult.key_version,
      algorithm: 'ed25519',
      generatedAt: storeResult.generated_at,
      retiredKeyId: currentActive.key_id,
      retiredKeyVersion: currentActive.key_version,
      idempotent: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton signer instance. Lazy-init on first method call. */
export const artifactSigner = new ArtifactSigner();
