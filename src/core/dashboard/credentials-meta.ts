/**
 * credentials-meta.ts
 *
 * Read-only **metadata** view of the AES-256-GCM secret vault for the
 * `GET /api/admin/credentials` dashboard endpoint (gap #28b slice 3).
 *
 * Security posture:
 *
 *   - **NEVER decrypts.** The vault's master key (env or scrypt-from-
 *     passphrase) is not touched here. We parse the on-disk JSON envelope
 *     only for the non-secret metadata fields (createdAt, rotatedAt,
 *     expiresAt) and the key NAMES. The ciphertext/nonce/tag fields are
 *     not surfaced.
 *
 *   - **NO last-N hint.** Hermes's debug-share leaks a 4-char tail of
 *     credentials; sudo-ai's vault file never has plaintext on disk, so
 *     even if we wanted that hint we'd have to decrypt every entry on
 *     every list call — which would defeat the at-rest encryption design.
 *     Slice 3 surfaces metadata only.
 *
 *   - **Legacy v1 files** (no kdfSalt) are reported as a legacy-format
 *     stub rather than silently skipped — operators need to know they
 *     have a stale namespace requiring `sudo vault migrate-legacy`.
 *
 * The vault directory location matches `vault.ts:19` (`workspace/vault`
 * resolved from CWD). Override via the `vaultDir` argument for tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { VaultEntry, VaultNamespaceFile } from '../security/vault.js';

/**
 * Default vault path. **Resolved lazily per call** to match `vault.ts:19`
 * behavior (`path.resolve('workspace/vault')`) but tolerate a runner that
 * changes `process.cwd()` after import. Tests pass an explicit `vaultDir`
 * argument; production callers get the same resolution they'd get from
 * vault.ts because both are computed from the same `cwd` at the same time.
 */
export function defaultVaultDir(): string {
  return path.resolve('workspace/vault');
}

/** Public, non-secret per-entry metadata. */
export interface CredentialEntryMeta {
  key: string;
  createdAt: string;
  rotatedAt?: string;
  expiresAt?: string;
  /** True iff `expiresAt` is in the past at scan time. */
  expired?: boolean;
}

/** Per-namespace summary returned by `listCredentialsMetadata`. */
export type CredentialNamespaceMeta =
  | {
      namespace: string;
      format: 'v2';
      entries: CredentialEntryMeta[];
    }
  | {
      namespace: string;
      format: 'legacy-v1';
      /** Legacy files have no kdfSalt; we don't bother parsing entries. */
      reason: string;
    }
  | {
      namespace: string;
      format: 'unreadable';
      reason: string;
    };

/**
 * Snapshot returned to the dashboard endpoint. The `vaultConfigured` flag
 * mirrors the operator decision documented in `vault.ts`: vault keys are
 * configured iff `SUDO_VAULT_MASTER_KEY` or `SUDO_VAULT_PASSPHRASE` is set.
 * We never read them — just check presence — so we can tell the operator
 * whether `GET` would fail with `no_master_key` if they tried to decrypt.
 */
export interface CredentialsSnapshot {
  vaultDir: string;
  /** True iff the vault dir exists on disk. */
  vaultDirPresent: boolean;
  /** True iff a master key/passphrase env var is set (encryption configured). */
  vaultConfigured: boolean;
  namespaces: CredentialNamespaceMeta[];
}

/**
 * List all vault namespace metadata. Returns `vaultDirPresent: false` and
 * an empty namespace array when the vault dir doesn't exist (a fresh
 * install with no vault calls ever made). Never throws — directory or
 * parse failures are reported as `unreadable` entries.
 */
export function listCredentialsMetadata(vaultDir: string = defaultVaultDir()): CredentialsSnapshot {
  // Mirror `vault.ts:111-123` which treats an empty string the same as unset
  // (rejects with `no_master_key`). Plain `typeof === 'string'` would mark
  // an operator who blanked the var as configured when decryption would
  // actually fail.
  const masterKey = process.env['SUDO_VAULT_MASTER_KEY'];
  const passphrase = process.env['SUDO_VAULT_PASSPHRASE'];
  const vaultConfigured =
    (typeof masterKey === 'string' && masterKey.length > 0) ||
    (typeof passphrase === 'string' && passphrase.length > 0);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(vaultDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { vaultDir, vaultDirPresent: false, vaultConfigured, namespaces: [] };
    }
    // Any other error: report as a single unreadable namespace so the
    // endpoint stays honest about what failed.
    return {
      vaultDir,
      vaultDirPresent: false,
      vaultConfigured,
      namespaces: [
        { namespace: '<vault-dir>', format: 'unreadable', reason: (err as Error).message },
      ],
    };
  }

  const namespaces: CredentialNamespaceMeta[] = [];
  const now = new Date();

  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith('.json')) continue;
    // Skip audit log + any *.tmp.json residue from atomic-write crash recovery.
    if (dirent.name === 'audit.log') continue;
    if (dirent.name.includes('.tmp.json')) continue;

    const ns = dirent.name.slice(0, -'.json'.length);
    const filePath = path.join(vaultDir, dirent.name);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
      namespaces.push({ namespace: ns, format: 'unreadable', reason: (err as Error).message });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      namespaces.push({ namespace: ns, format: 'unreadable', reason: 'malformed JSON' });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      namespaces.push({ namespace: ns, format: 'unreadable', reason: 'not a JSON object' });
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    if (!('kdfSalt' in obj)) {
      namespaces.push({
        namespace: ns,
        format: 'legacy-v1',
        reason: 'no kdfSalt — run `sudo vault migrate-legacy ' + ns + '`',
      });
      continue;
    }

    const v2 = obj as Partial<VaultNamespaceFile>;
    const entriesField = v2.entries;
    if (entriesField === null || entriesField === undefined || typeof entriesField !== 'object') {
      namespaces.push({ namespace: ns, format: 'unreadable', reason: 'missing or malformed entries field' });
      continue;
    }

    const metas: CredentialEntryMeta[] = [];
    for (const [k, entry] of Object.entries(entriesField as Record<string, unknown>)) {
      if (entry === null || entry === undefined || typeof entry !== 'object') continue;
      const e = entry as Partial<VaultEntry>;
      const meta: CredentialEntryMeta = {
        key: k,
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : 'unknown',
      };
      if (typeof e.rotatedAt === 'string') meta.rotatedAt = e.rotatedAt;
      if (typeof e.expiresAt === 'string') {
        meta.expiresAt = e.expiresAt;
        const expiryDate = new Date(e.expiresAt);
        if (!Number.isNaN(expiryDate.getTime()) && expiryDate < now) {
          meta.expired = true;
        }
      }
      metas.push(meta);
    }
    // Sort keys for stable output (vault.list returns insertion order).
    metas.sort((a, b) => a.key.localeCompare(b.key));

    namespaces.push({ namespace: ns, format: 'v2', entries: metas });
  }

  namespaces.sort((a, b) => a.namespace.localeCompare(b.namespace));
  return { vaultDir, vaultDirPresent: true, vaultConfigured, namespaces };
}
