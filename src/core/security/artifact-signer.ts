/**
 * @file security/artifact-signer.ts
 * @description ArtifactSigner — SHA-256 file and content signing for SUDO-AI.
 *
 * Provides cryptographic integrity verification for artifacts using SHA-256
 * hashing and HMAC-SHA256 signatures. This is a lighter-weight signer than
 * the ed25519-based signer.ts — suited for local file integrity checks and
 * content-addressable verification.
 *
 * Key material is derived from a configurable secret (env SUDO_ARTIFACT_SECRET
 * or auto-generated on first use and stored in data/keys/artifact-secret).
 *
 * @module security/artifact-signer
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId, contentHash } from '../shared/utils.js';

const log = createLogger('security:artifact-signer');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Cryptographic signature attached to a signed artifact. */
export interface ArtifactSignature {
  /** Signature algorithm used. */
  algorithm: 'sha256';
  /** SHA-256 hex digest of the artifact content. */
  hash: string;
  /** HMAC-SHA256 hex-encoded signature over the hash. */
  signature: string;
  /** ISO-8601 timestamp of when the signature was created. */
  signedAt: string;
  /** Identity of the signer (hostname:pid or configured signer name). */
  signer: string;
}

/** Configuration for the ArtifactSigner. */
export interface SignerConfig {
  /** Directory for key storage (default: data/keys). */
  keyDir?: string;
  /** Signer identity string (default: hostname:pid). */
  signerId?: string;
  /** Whether to auto-generate a secret if none exists (default: true). */
  autoSeed?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_KEY_DIR = path.resolve('data', 'keys');
const SECRET_FILENAME = 'artifact-secret';
const HMAC_ALGORITHM = 'sha256';
const HASH_ALGORITHM = 'sha256';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getKeyDir(config?: SignerConfig): string {
  return config?.keyDir ?? process.env['SUDO_ARTIFACT_KEY_DIR'] ?? DEFAULT_KEY_DIR;
}

function getSignerId(config?: SignerConfig): string {
  if (config?.signerId) return config.signerId;
  const envId = process.env['SUDO_ARTIFACT_SIGNER_ID'];
  if (envId) return envId;
  return `${require('node:os').hostname()}:${process.pid}`;
}

/** Read or create the HMAC secret key. */
function ensureSecret(keyDir: string, autoSeed: boolean): string {
  const secretPath = path.join(keyDir, SECRET_FILENAME);

  // Try reading existing secret.
  try {
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    if (secret.length >= 32) return secret;
  } catch {
    // File does not exist or is unreadable.
  }

  if (!autoSeed) {
    throw new Error(`ArtifactSigner: no secret at ${secretPath} and autoSeed is disabled`);
  }

  // Auto-generate a 64-byte hex secret (256 bits of entropy).
  const secret = crypto.randomBytes(64).toString('hex');

  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(secretPath, 0o600); } catch { /* non-fatal */ }

  log.info({ path: secretPath }, 'ArtifactSigner: auto-generated HMAC secret');
  return secret;
}

/** Compute HMAC-SHA256 of a message using the given secret. */
function hmacSign(secret: string, message: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, secret).update(message, 'utf8').digest('hex');
}

/** Verify HMAC-SHA256 of a message against an expected signature. */
function hmacVerify(secret: string, message: string, signature: string): boolean {
  const expected = hmacSign(secret, message);
  // Constant-time comparison to prevent timing attacks.
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

// ---------------------------------------------------------------------------
// ArtifactSigner class
// ---------------------------------------------------------------------------

/**
 * Signs and verifies files and content using SHA-256 hashing and HMAC-SHA256.
 *
 * Unlike the ed25519 signer (signer.ts) which is designed for key-rotated
 * long-lived artifact signing, ArtifactSigner provides a lightweight integrity
 * mechanism for local file and content verification.
 */
export class ArtifactSigner {
  private readonly _secret: string;
  private readonly _signerId: string;

  constructor(config?: SignerConfig) {
    const keyDir = getKeyDir(config);
    const autoSeed = config?.autoSeed ?? true;
    this._secret = process.env['SUDO_ARTIFACT_SECRET'] ?? ensureSecret(keyDir, autoSeed);
    this._signerId = getSignerId(config);
    log.info({ signerId: this._signerId }, 'ArtifactSigner initialized');
  }

  // -------------------------------------------------------------------------
  // File-based API
  // -------------------------------------------------------------------------

  /**
   * Sign a file at the given path.
   *
   * Reads the file, computes SHA-256 hash and HMAC-SHA256 signature,
   * and returns an ArtifactSignature metadata object. The signature
   * can be persisted alongside the file for later verification.
   *
   * @param filePath - Absolute path to the file to sign.
   * @returns ArtifactSignature with hash, signature, timestamp, and signer.
   * @throws Error if the file cannot be read.
   */
  sign(filePath: string): ArtifactSignature {
    if (!filePath || typeof filePath !== 'string') {
      throw new TypeError('ArtifactSigner.sign: filePath must be a non-empty string');
    }

    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash(HASH_ALGORITHM).update(content).digest('hex');
    const signature = hmacSign(this._secret, hash);
    const signedAt = new Date().toISOString();

    log.debug({ filePath, hash: hash.slice(0, 16), signer: this._signerId }, 'File signed');

    return {
      algorithm: 'sha256',
      hash,
      signature,
      signedAt,
      signer: this._signerId,
    };
  }

  /**
   * Verify a file against a previously generated ArtifactSignature.
   *
   * Re-reads the file, recomputes the hash and signature, and compares
   * against the provided signature object. Returns true only if both
   * the hash and HMAC signature match.
   *
   * @param filePath - Absolute path to the file to verify.
   * @param sig      - The ArtifactSignature to verify against.
   * @returns True if the file content matches the signature, false otherwise.
   */
  verify(filePath: string, sig: ArtifactSignature): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    try {
      const content = fs.readFileSync(filePath);
      const hash = crypto.createHash(HASH_ALGORITHM).update(content).digest('hex');

      // Check hash first (fast rejection).
      if (hash !== sig.hash) {
        log.debug({ filePath, expected: sig.hash.slice(0, 16), actual: hash.slice(0, 16) }, 'Verification failed: hash mismatch');
        return false;
      }

      // Verify HMAC signature.
      if (!hmacVerify(this._secret, hash, sig.signature)) {
        log.debug({ filePath }, 'Verification failed: signature mismatch');
        return false;
      }

      log.debug({ filePath, hash: hash.slice(0, 16) }, 'File verified successfully');
      return true;
    } catch (err) {
      log.debug({ filePath, err: String(err) }, 'Verification failed: file read error');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Content-based API
  // -------------------------------------------------------------------------

  /**
   * Sign arbitrary string content.
   *
   * Computes SHA-256 hash and HMAC-SHA256 signature of the content string.
   * Useful for signing in-memory data, API responses, or configuration blobs.
   *
   * @param content - The string content to sign.
   * @returns ArtifactSignature with hash, signature, timestamp, and signer.
   */
  signContent(content: string): ArtifactSignature {
    if (typeof content !== 'string') {
      throw new TypeError('ArtifactSigner.signContent: content must be a string');
    }

    const hash = crypto.createHash(HASH_ALGORITHM).update(content, 'utf8').digest('hex');
    const signature = hmacSign(this._secret, hash);
    const signedAt = new Date().toISOString();

    log.debug({ hash: hash.slice(0, 16), signer: this._signerId }, 'Content signed');

    return {
      algorithm: 'sha256',
      hash,
      signature,
      signedAt,
      signer: this._signerId,
    };
  }

  /**
   * Verify arbitrary string content against an ArtifactSignature.
   *
   * @param content - The string content to verify.
   * @param sig     - The ArtifactSignature to verify against.
   * @returns True if the content matches the signature, false otherwise.
   */
  verifyContent(content: string, sig: ArtifactSignature): boolean {
    if (typeof content !== 'string') {
      return false;
    }

    try {
      const hash = crypto.createHash(HASH_ALGORITHM).update(content, 'utf8').digest('hex');

      if (hash !== sig.hash) {
        log.debug({ expected: sig.hash.slice(0, 16), actual: hash.slice(0, 16) }, 'Content verification failed: hash mismatch');
        return false;
      }

      if (!hmacVerify(this._secret, hash, sig.signature)) {
        log.debug('Content verification failed: signature mismatch');
        return false;
      }

      log.debug({ hash: hash.slice(0, 16) }, 'Content verified successfully');
      return true;
    } catch (err) {
      log.debug({ err: String(err) }, 'Content verification error');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /**
   * Compute the SHA-256 hash of a file without signing it.
   *
   * @param filePath - Absolute path to the file.
   * @returns Hex-encoded SHA-256 digest.
   */
  hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash(HASH_ALGORITHM).update(content).digest('hex');
  }

  /**
   * Compute the SHA-256 hash of string content without signing it.
   *
   * @param content - The string to hash.
   * @returns Hex-encoded SHA-256 digest.
   */
  hashContent(content: string): string {
    return crypto.createHash(HASH_ALGORITHM).update(content, 'utf8').digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton ArtifactSigner instance. */
export const artifactSigner = new ArtifactSigner();