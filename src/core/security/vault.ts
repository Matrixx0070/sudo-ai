/**
 * @file security/vault.ts
 * @description Secrets Vault — AES-256-GCM encrypted at-rest key storage.
 * Crypto: AES-256-GCM, 12-byte random nonce, 16-byte GCM auth tag, AAD = "namespace:key".
 * KDF: SUDO_VAULT_MASTER_KEY (64 hex) or scrypt(passphrase, per-namespace-salt, N=16384, r=8, p=1).
 * Storage: workspace/vault/<namespace>.json, atomic writes (tmp+rename), 0600/0700 perms.
 * Namespace file shape: { kdfSalt: "<hex>", entries: { [key]: VaultEntry } }
 * Audit: workspace/vault/audit.log, append-only NDJSON, never logs values or key material.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { HookManager } from '../hooks/index.js';

const log = createLogger('vault');

/**
 * Vault directory — cwd-relative default, overridable via SUDO_VAULT_DIR.
 * Resolved LAZILY (per call) so tests can point it at a tmpdir at runtime:
 * the module-load-time constant let 557 vault.test.ts runs write ~10K test
 * namespaces + a 2.9MB audit.log into the REAL prod workspace/vault
 * (discovered + cleaned 2026-07-18).
 */
function vaultDir(): string {
  const env = process.env['SUDO_VAULT_DIR'];
  return env !== undefined && env.trim() !== '' ? path.resolve(env) : path.resolve('workspace/vault');
}
function auditLogPath(): string {
  return path.join(vaultDir(), 'audit.log');
}
const NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/;

// Static salt ONLY retained for migrate-legacy path — never used for new namespaces.
export const LEGACY_SCRYPT_SALT = Buffer.from('sudo-ai-vault-v1', 'utf8');

// ── Public types ──────────────────────────────────────────────────────────────

export interface VaultSetOptions { expiresAt?: string; }

export interface VaultEntry {
  ciphertext: string; nonce: string; tag: string;
  createdAt: string; rotatedAt?: string; expiresAt?: string;
}

/** Internal on-disk namespace shape (v2 with per-namespace KDF salt). */
export interface VaultNamespaceFile {
  kdfSalt: string;
  entries: Record<string, VaultEntry>;
}

/** @deprecated Legacy shape: flat object without kdfSalt (v1). */
export interface VaultNamespaceLegacy { [key: string]: VaultEntry; }

export interface VaultGetResult {
  value: string;
  entry: Omit<VaultEntry, 'ciphertext' | 'nonce' | 'tag'>;
}

export interface VaultAPI {
  set(namespace: string, key: string, value: string, opts?: VaultSetOptions): Promise<void>;
  get(namespace: string, key: string, requester: string): Promise<VaultGetResult | null>;
  list(namespace: string): Promise<string[]>;
  rotate(namespace: string, key: string, requester: string): Promise<void>;
  delete(namespace: string, key: string, requester: string): Promise<void>;
}

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_master_key'
      | 'invalid_namespace'
      | 'key_not_found'
      | 'decryption_failed'
      | 'key_expired'
      | 'legacy_format',
  ) { super(message); this.name = 'VaultError'; }
}

interface AuditLogEntry {
  ts: string; action: 'get' | 'set' | 'rotate' | 'delete' | 'list';
  namespace: string; key: string; requester: string; success: boolean; reason?: string;
}

// ── Hook injection ────────────────────────────────────────────────────────────

let _hooks: HookManager | null = null;

/** Inject a HookManager so vault emits lifecycle events. Fire-and-forget. */
export function initVault(hooks: HookManager): void { _hooks = hooks; }

// ── Directory setup ───────────────────────────────────────────────────────────

try {
  fs.mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
} catch (err) {
  log.warn({ err: String(err) }, 'vault: could not create vault directory');
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Single cached master key when SUDO_VAULT_MASTER_KEY is set.
 * Null means not yet derived or cache was cleared.
 */
let _envMasterKeyCache: Buffer | null = null;

/**
 * Per-namespace derived keys when SUDO_VAULT_PASSPHRASE is used.
 * Keyed by the namespace's kdfSalt hex string so each namespace is isolated.
 */
const _passphraseKeyCache = new Map<string, Buffer>();

/**
 * Derive (or return cached) master key.
 * - If SUDO_VAULT_MASTER_KEY is set, returns the env-based key (salt is ignored).
 * - If SUDO_VAULT_PASSPHRASE is set, derives a key from scrypt using the per-namespace salt.
 * @param namespaceSalt  Hex-encoded per-namespace 16-byte salt (ignored when env key is set).
 */
function getMasterKey(namespaceSalt: string): Buffer {
  const rawHex = process.env['SUDO_VAULT_MASTER_KEY'];
  if (rawHex !== undefined) {
    if (_envMasterKeyCache !== null) return _envMasterKeyCache;
    if (rawHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(rawHex)) {
      throw new VaultError('SUDO_VAULT_MASTER_KEY must be exactly 64 hex characters', 'no_master_key');
    }
    _envMasterKeyCache = Buffer.from(rawHex, 'hex');
    return _envMasterKeyCache;
  }

  const passphrase = process.env['SUDO_VAULT_PASSPHRASE'];
  if (!passphrase) {
    throw new VaultError('Vault not configured: set SUDO_VAULT_MASTER_KEY or SUDO_VAULT_PASSPHRASE', 'no_master_key');
  }

  const cached = _passphraseKeyCache.get(namespaceSalt);
  if (cached !== undefined) return cached;

  const saltBuf = Buffer.from(namespaceSalt, 'hex');
  const derived = crypto.scryptSync(passphrase, saltBuf, 32, { N: 16384, r: 8, p: 1 });
  _passphraseKeyCache.set(namespaceSalt, derived);
  return derived;
}

/**
 * Reset the master key cache.
 * In test environments (NODE_ENV=test) this clears both caches.
 * In production this is a no-op to prevent accidental cache invalidation.
 */
export function _resetMasterKeyCache(): void {
  if (process.env['NODE_ENV'] !== 'test') return;
  _envMasterKeyCache = null;
  _passphraseKeyCache.clear();
}

// ── Crypto primitives ─────────────────────────────────────────────────────────

/**
 * Encrypt plaintext under masterKey.
 * AAD = "namespace:key" binds the ciphertext to its slot — prevents cross-record swaps.
 */
function encrypt(namespace: string, key: string, plaintext: string, masterKey: Buffer): VaultEntry {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(Buffer.from(`${namespace}:${key}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('hex'),
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Decrypt a VaultEntry.
 * AAD = "namespace:key" must match what was used during encryption.
 * Throws decryption_failed if tag verification fails (including AAD mismatch).
 */
function decrypt(namespace: string, key: string, entry: VaultEntry, masterKey: Buffer): string {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', masterKey, Buffer.from(entry.nonce, 'hex'),
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    decipher.setAAD(Buffer.from(`${namespace}:${key}`, 'utf8'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new VaultError('decryption failed', 'decryption_failed');
  }
}

// ── Namespace I/O ─────────────────────────────────────────────────────────────

function validateNamespace(ns: string): void {
  if (!NAMESPACE_RE.test(ns)) throw new VaultError(`Invalid namespace: ${ns}`, 'invalid_namespace');
}

/**
 * Read a namespace file.
 * - If file does not exist: returns a fresh file with a random kdfSalt and empty entries.
 * - If file exists but lacks kdfSalt (legacy v1 format): throws VaultError('legacy_format').
 * - Otherwise returns the parsed VaultNamespaceFile.
 */
async function readNamespaceFile(namespace: string): Promise<VaultNamespaceFile> {
  validateNamespace(namespace);
  const filePath = path.join(vaultDir(), `${namespace}.json`);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Detect legacy v1 format: top-level keys are VaultEntry objects, not a kdfSalt+entries shape.
    if (!('kdfSalt' in parsed)) {
      throw new VaultError(
        `Namespace "${namespace}" uses legacy vault format (no kdfSalt). ` +
        `Run: sudo vault migrate-legacy ${namespace}`,
        'legacy_format',
      );
    }

    return parsed as unknown as VaultNamespaceFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Brand-new namespace: generate a fresh random salt
      return {
        kdfSalt: crypto.randomBytes(16).toString('hex'),
        entries: {},
      };
    }
    throw err;
  }
}

async function writeNamespaceFile(namespace: string, data: VaultNamespaceFile): Promise<void> {
  validateNamespace(namespace);
  const filePath = path.join(vaultDir(), `${namespace}.json`);
  const tmpPath = path.join(vaultDir(), `${namespace}.${crypto.randomUUID()}.tmp.json`);
  await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    // Cleanup orphaned tmp file to avoid leaving encrypted data on disk
    try { await fs.promises.unlink(tmpPath); } catch { /* non-fatal */ }
    throw err;
  }
  try { await fs.promises.chmod(filePath, 0o600); } catch { /* non-fatal */ }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

function audit(entry: AuditLogEntry): void {
  try { fs.appendFileSync(auditLogPath(), JSON.stringify(entry) + '\n', 'utf8'); }
  catch (err) { log.warn({ err: String(err) }, 'vault: audit log write failed'); }
}

// ── Hook emission (fire-and-forget) ──────────────────────────────────────────

function emitHook(
  event: 'vault:set' | 'vault:get' | 'vault:rotate' | 'vault:delete',
  vaultNamespace: string, vaultKey: string, requester: string,
): void {
  if (!_hooks) return;
  const h = _hooks;
  void (async () => {
    try { await h.emit(event, { event, vaultNamespace, vaultKey, requester }); }
    catch { /* broken hook must never break vault op */ }
  })();
}

// ── VaultAPI singleton ────────────────────────────────────────────────────────

const vaultImpl: VaultAPI = {
  async set(namespace, key, value, opts) {
    const nsFile = await readNamespaceFile(namespace);
    const masterKey = getMasterKey(nsFile.kdfSalt);
    const entry = encrypt(namespace, key, value, masterKey);
    if (opts?.expiresAt) entry.expiresAt = opts.expiresAt;
    nsFile.entries[key] = entry;
    await writeNamespaceFile(namespace, nsFile);
    audit({ ts: new Date().toISOString(), action: 'set', namespace, key, requester: 'system', success: true });
    emitHook('vault:set', namespace, key, 'system');
  },

  async get(namespace, key, requester) {
    let nsFile: VaultNamespaceFile;
    try { nsFile = await readNamespaceFile(namespace); }
    catch (err) {
      audit({ ts: new Date().toISOString(), action: 'get', namespace, key, requester, success: false, reason: 'read_error' });
      throw err;
    }
    const masterKey = getMasterKey(nsFile.kdfSalt);
    const entry = nsFile.entries[key];
    if (entry === undefined) {
      audit({ ts: new Date().toISOString(), action: 'get', namespace, key, requester, success: false, reason: 'key_not_found' });
      throw new VaultError(`Key not found: ${key}`, 'key_not_found');
    }
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      audit({ ts: new Date().toISOString(), action: 'get', namespace, key, requester, success: false, reason: 'key_expired' });
      emitHook('vault:get', namespace, key, requester);
      return null;
    }
    const value = decrypt(namespace, key, entry, masterKey);
    audit({ ts: new Date().toISOString(), action: 'get', namespace, key, requester, success: true });
    emitHook('vault:get', namespace, key, requester);
    return {
      value,
      entry: {
        createdAt: entry.createdAt,
        ...(entry.rotatedAt ? { rotatedAt: entry.rotatedAt } : {}),
        ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      },
    };
  },

  async list(namespace) {
    const nsFile = await readNamespaceFile(namespace);
    audit({ ts: new Date().toISOString(), action: 'list', namespace, key: '', requester: 'anonymous', success: true });
    return Object.keys(nsFile.entries);
  },

  async rotate(namespace, key, requester) {
    const nsFile = await readNamespaceFile(namespace);
    const masterKey = getMasterKey(nsFile.kdfSalt);
    const existing = nsFile.entries[key];
    if (existing === undefined) {
      audit({ ts: new Date().toISOString(), action: 'rotate', namespace, key, requester, success: false, reason: 'key_not_found' });
      throw new VaultError(`Key not found: ${key}`, 'key_not_found');
    }
    const plaintext = decrypt(namespace, key, existing, masterKey);
    const newEntry = encrypt(namespace, key, plaintext, masterKey);
    newEntry.rotatedAt = new Date().toISOString();
    if (existing.expiresAt) newEntry.expiresAt = existing.expiresAt;
    nsFile.entries[key] = newEntry;
    await writeNamespaceFile(namespace, nsFile);
    audit({ ts: new Date().toISOString(), action: 'rotate', namespace, key, requester, success: true });
    emitHook('vault:rotate', namespace, key, requester);
  },

  async delete(namespace, key, requester) {
    const nsFile = await readNamespaceFile(namespace);
    if (!(key in nsFile.entries)) {
      audit({ ts: new Date().toISOString(), action: 'delete', namespace, key, requester, success: false, reason: 'key_not_found' });
      throw new VaultError(`Key not found: ${key}`, 'key_not_found');
    }
    delete nsFile.entries[key];
    await writeNamespaceFile(namespace, nsFile);
    audit({ ts: new Date().toISOString(), action: 'delete', namespace, key, requester, success: true });
    emitHook('vault:delete', namespace, key, requester);
  },
};

/** Module-level singleton vault instance. */
export const vault: VaultAPI = vaultImpl;
