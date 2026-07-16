/**
 * @file gdrive/keys.ts
 * @description Local key material for the signed/encrypted brain (F17/F29).
 *
 * Two independent keys, both generated LOCALLY by the operator
 * (`openssl rand -hex 32 > <path> && chmod 600 <path>`), both living at paths
 * OUTSIDE the repo, both NEVER synced, committed, or logged:
 *
 * - BRAIN_HMAC_KEY_PATH — signs manifests (tamper evidence, F17)
 * - BRAIN_ENC_KEY_PATH  — AES-256-GCM for zone-1 blobs (confidentiality, F29)
 *
 * Missing/short keys fail fast with actionable messages (prime directive 7:
 * key-missing must abort before any sync work, never degrade to unsigned).
 */

import { readFileSync, statSync } from 'node:fs';
import { GdriveConfigError } from './config.js';

export interface BrainKeys {
  hmacKey: Buffer;
  /** Absent when no zone-1 content is in play (enc key is only required then). */
  encKey?: Buffer;
}

const MIN_KEY_BYTES = 32;

function loadKeyFile(path: string, envName: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    throw new GdriveConfigError(
      `${envName} points to an unreadable file: ${path} — generate one with ` +
        `"openssl rand -hex 32 > ${path} && chmod 600 ${path}"`,
    );
  }
  const key = /^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf-8');
  if (key.length < MIN_KEY_BYTES) {
    throw new GdriveConfigError(
      `${envName} key is ${key.length} bytes; need >= ${MIN_KEY_BYTES} — regenerate with "openssl rand -hex 32"`,
    );
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // Group/world-readable key: refuse. A quietly-readable signing key
      // defeats the whole tamper-evidence story.
      throw new GdriveConfigError(
        `${envName} file ${path} has mode ${mode.toString(8)} — must be 0600 (chmod 600 ${path})`,
      );
    }
  } catch (err) {
    if (err instanceof GdriveConfigError) throw err;
    // stat failed on an exotic fs — permissions unverifiable; proceed.
  }
  return key;
}

/** Load the manifest-signing key (required for any push/hydrate). */
export function loadHmacKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const p = env['BRAIN_HMAC_KEY_PATH'];
  if (!p) {
    throw new GdriveConfigError(
      'BRAIN_HMAC_KEY_PATH is required for brain sync — see docs/gdrive-setup.md (key material)',
    );
  }
  return loadKeyFile(p, 'BRAIN_HMAC_KEY_PATH');
}

/** Load the zone-1 encryption key (required only when zone-1 blobs exist). */
export function loadEncKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const p = env['BRAIN_ENC_KEY_PATH'];
  if (!p) {
    throw new GdriveConfigError(
      'BRAIN_ENC_KEY_PATH is required to sync zone-1 (encrypted) memories — ' +
        'generate with "openssl rand -hex 32", or keep such memories zone 0 (local-only)',
    );
  }
  return loadKeyFile(p, 'BRAIN_ENC_KEY_PATH');
}
