/**
 * @file gdrive/zones.ts
 * @description F29 — sensitivity zones + zone-1 encryption.
 *
 * Zone 0: never leaves local disk (filtered out of every push payload —
 *         asserted by tests on the push queue).
 * Zone 1: syncs as AES-256-GCM ciphertext; blob named by sha256 of the
 *         CIPHERTEXT (integrity verifiable without the key); loses Drive
 *         full-text search / readable revision diffs — documented tradeoff.
 * Zone 2: plaintext sync.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type Zone = 0 | 1 | 2;

// Wire format: [1-byte version=1][12-byte IV][16-byte GCM tag][ciphertext]
const WIRE_VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export class ZoneCryptoError extends Error {
  constructor(message: string) {
    super(`zone-crypto: ${message}`);
    this.name = 'ZoneCryptoError';
  }
}

/** Encrypt a zone-1 payload. Random IV per blob — never reused. */
export function encryptZone1(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([WIRE_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Decrypt a zone-1 payload. Throws ZoneCryptoError on tamper/wrong key. */
export function decryptZone1(data: Buffer, key: Buffer): Buffer {
  if (data.length < 1 + IV_LEN + TAG_LEN) throw new ZoneCryptoError('payload too short');
  if (data[0] !== WIRE_VERSION) throw new ZoneCryptoError(`unknown wire version ${data[0]}`);
  const iv = data.subarray(1, 1 + IV_LEN);
  const tag = data.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const body = data.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new ZoneCryptoError('decrypt failed — wrong key or tampered ciphertext');
  }
}

// ---------------------------------------------------------------------------
// Default zone classification (consolidation-time helper)
// ---------------------------------------------------------------------------

/** Explicit never-sync markers force zone 0. */
const ZONE0_MARKERS = /\bnever-sync\b|\bzone:\s*0\b/i;

/**
 * Credential/financial/personal-adjacent content defaults to zone 1.
 * Deliberately coarse — false positives cost search convenience, false
 * negatives cost confidentiality, so the patterns lean broad.
 */
const ZONE1_PATTERNS: RegExp[] = [
  /\b(password|passwd|passphrase)\b/i,
  /\b(api[-_ ]?key|secret[-_ ]?key|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|bearer)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(ssn|social security)\b/i,
  /\b(credit card|card number|cvv|iban|routing number|account number)\b/i,
  /\b(salary|payroll|net worth|bank balance)\b/i,
  /\b(medical|diagnosis|prescription)\b/i,
];

/** Classify content into a default zone. Explicit override always wins. */
export function classifyZone(text: string, explicit?: Zone): Zone {
  if (explicit !== undefined) return explicit;
  if (ZONE0_MARKERS.test(text)) return 0;
  if (ZONE1_PATTERNS.some((p) => p.test(text))) return 1;
  return 2;
}
