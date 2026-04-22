/**
 * @file security/vault-cli.ts
 * @description CLI shim for the Secrets Vault.
 *
 * Usage:
 *   sudo vault import-env <namespace>        Import well-known API keys from process.env
 *   sudo vault list <namespace>              List keys stored in a namespace
 *   sudo vault rotate <namespace> <key>      Rotate (re-encrypt) a key
 *   sudo vault migrate-legacy <namespace>    Migrate v1 (static-salt) namespace to v2 format
 *
 * Secrets are NEVER echoed to stdout unless --show flag is given AND stdin is a TTY.
 * After import-env, operator must manually remove entries from .env — we do not modify it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import { vault, LEGACY_SCRYPT_SALT, VaultEntry, VaultNamespaceFile } from './vault.js';

const VAULT_DIR = path.resolve('workspace/vault');

// ---------------------------------------------------------------------------
// Well-known environment variable names for import-env
// ---------------------------------------------------------------------------

const WELL_KNOWN_KEYS = [
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_TOKEN',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'WHATSAPP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'GITHUB_TOKEN',
  'NOTION_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'SUDO_VAULT_MASTER_KEY',  // intentionally omitted — would be circular
];

// Filter: never import the master key itself
const IMPORTABLE_KEYS = WELL_KNOWN_KEYS.filter(k => k !== 'SUDO_VAULT_MASTER_KEY');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptPassword(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // Disable echo for password input on TTYs
    if (process.stdin.isTTY) {
      process.stdout.write(question);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).setRawMode?.(true);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) {
        process.stdout.write('\n');
      }
      resolve(answer);
    });
  });
}

function stdout(msg: string): void {
  process.stdout.write(msg + '\n');
}

function stderr(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// Command: import-env <namespace>
// ---------------------------------------------------------------------------

async function cmdImportEnv(namespace: string): Promise<void> {
  // Detect which well-known keys are present in the environment
  const present = IMPORTABLE_KEYS.filter(k => process.env[k] !== undefined);

  if (present.length === 0) {
    stdout('No well-known environment variables found. Nothing to import.');
    return;
  }

  stdout(`Found ${present.length} key(s) to import into namespace "${namespace}":`);
  for (const k of present) {
    stdout(`  - ${k}`);
  }
  stdout('');
  stdout('WARNING: Values will be encrypted and stored in workspace/vault/. ');
  stdout('After import, remove these entries from your .env manually.');
  stdout('');

  const answer = await prompt('Proceed with import? [y/N] ');
  if (answer.trim().toLowerCase() !== 'y') {
    stdout('Import cancelled.');
    return;
  }

  let imported = 0;
  let failed = 0;
  for (const k of present) {
    const value = process.env[k];
    if (value === undefined) continue;
    try {
      await vault.set(namespace, k, value);
      stdout(`  Imported: ${k}`);
      imported++;
    } catch (err) {
      stderr(`  FAILED: ${k} — ${String(err)}`);
      failed++;
    }
  }

  stdout('');
  stdout(`Done. Imported: ${imported}, Failed: ${failed}`);
  if (imported > 0) {
    stdout('IMPORTANT: Remove the imported keys from your .env file manually.');
  }
}

// ---------------------------------------------------------------------------
// Command: list <namespace>
// ---------------------------------------------------------------------------

async function cmdList(namespace: string): Promise<void> {
  const keys = await vault.list(namespace);
  if (keys.length === 0) {
    stdout(`Namespace "${namespace}" is empty.`);
    return;
  }
  stdout(`Keys in namespace "${namespace}" (${keys.length}):`);
  for (const k of keys) {
    stdout(`  - ${k}`);
  }
}

// ---------------------------------------------------------------------------
// Command: rotate <namespace> <key>
// ---------------------------------------------------------------------------

async function cmdRotate(namespace: string, key: string): Promise<void> {
  await vault.rotate(namespace, key, 'cli:rotate');
  stdout(`Rotated: ${namespace}/${key}`);
}

// ---------------------------------------------------------------------------
// Command: migrate-legacy <namespace>
// Reads a v1 (static-salt) namespace file, decrypts all entries using the
// legacy scrypt derivation, re-encrypts under a fresh per-namespace salt,
// and writes the v2 format. The v1 file is backed up as <namespace>.v1.bak.
// ---------------------------------------------------------------------------

async function cmdMigrateLegacy(namespace: string): Promise<void> {
  const NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/;
  if (!NAMESPACE_RE.test(namespace)) {
    stderr(`Invalid namespace: ${namespace}`);
    process.exitCode = 1;
    return;
  }

  const filePath = path.join(VAULT_DIR, `${namespace}.json`);

  // Verify the file exists and is in legacy format
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      stderr(`Namespace file not found: ${filePath}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const parsed = JSON.parse(rawContent) as Record<string, unknown>;
  if ('kdfSalt' in parsed) {
    stdout(`Namespace "${namespace}" is already in v2 format. No migration needed.`);
    return;
  }

  // Legacy format: flat { [key]: VaultEntry }
  const legacyEntries = parsed as Record<string, VaultEntry>;
  const entryKeys = Object.keys(legacyEntries);

  if (entryKeys.length === 0) {
    stdout(`Namespace "${namespace}" is empty. Nothing to migrate.`);
    return;
  }

  stdout(`Found ${entryKeys.length} key(s) in legacy namespace "${namespace}".`);
  stdout('This migration requires your vault passphrase to decrypt and re-encrypt entries.');
  stdout('');

  // Read passphrase — only the passphrase path uses the legacy static salt
  const passphrase = await promptPassword('Enter SUDO_VAULT_PASSPHRASE: ');
  if (!passphrase) {
    stderr('Passphrase is required for migration.');
    process.exitCode = 1;
    return;
  }

  // Derive the legacy master key using the old static salt
  const legacyKey = crypto.scryptSync(passphrase, LEGACY_SCRYPT_SALT, 32, { N: 16384, r: 8, p: 1 });

  // Decrypt all entries
  const plaintexts: Record<string, { value: string; entry: VaultEntry }> = {};
  for (const key of entryKeys) {
    const entry = legacyEntries[key];
    if (!entry) continue;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', legacyKey, Buffer.from(entry.nonce, 'hex'),
      ) as crypto.DecipherGCM;
      decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(entry.ciphertext, 'hex')),
        decipher.final(),
      ]).toString('utf8');
      plaintexts[key] = { value: plaintext, entry };
    } catch {
      stderr(`  FAILED to decrypt key "${key}". Aborting — no changes written.`);
      process.exitCode = 1;
      return;
    }
  }

  stdout(`Decrypted ${entryKeys.length} key(s) successfully.`);

  // Generate a fresh per-namespace salt
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newKey = crypto.scryptSync(passphrase, Buffer.from(newSalt, 'hex'), 32, { N: 16384, r: 8, p: 1 });

  // Re-encrypt with the new key and AAD binding
  const newEntries: Record<string, VaultEntry> = {};
  for (const key of entryKeys) {
    const item = plaintexts[key];
    if (!item) continue;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', newKey, nonce);
    cipher.setAAD(Buffer.from(`${namespace}:${key}`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(item.value, 'utf8'), cipher.final()]);
    const newEntry: VaultEntry = {
      ciphertext: encrypted.toString('hex'),
      nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      createdAt: item.entry.createdAt,
    };
    if (item.entry.rotatedAt) newEntry.rotatedAt = item.entry.rotatedAt;
    if (item.entry.expiresAt) newEntry.expiresAt = item.entry.expiresAt;
    newEntries[key] = newEntry;
  }

  // Backup the original file
  const backupPath = path.join(VAULT_DIR, `${namespace}.v1.bak`);
  fs.copyFileSync(filePath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  stdout(`Backed up original file to: ${backupPath}`);

  // Write new v2 format atomically
  const newData: VaultNamespaceFile = { kdfSalt: newSalt, entries: newEntries };
  const tmpPath = path.join(VAULT_DIR, `${namespace}.${crypto.randomUUID()}.tmp.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newData, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* non-fatal */ }
    stderr(`Failed to write migrated file: ${String(err)}`);
    stderr(`Original file is unchanged. Backup at: ${backupPath}`);
    process.exitCode = 1;
    return;
  }

  stdout(`Migration complete. Namespace "${namespace}" is now in v2 format.`);
  stdout(`Migrated ${entryKeys.length} key(s) with new per-namespace KDF salt.`);
  stdout('');
  stdout('IMPORTANT: Verify your vault works correctly, then delete the backup:');
  stdout(`  rm ${backupPath}`);
}

// ---------------------------------------------------------------------------
// Main CLI dispatcher
// ---------------------------------------------------------------------------

export async function runVaultCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;

  switch (command) {
    case 'import-env': {
      const namespace = rest[0];
      if (!namespace) {
        stderr('Usage: vault import-env <namespace>');
        process.exitCode = 1;
        return;
      }
      await cmdImportEnv(namespace);
      break;
    }
    case 'list': {
      const namespace = rest[0];
      if (!namespace) {
        stderr('Usage: vault list <namespace>');
        process.exitCode = 1;
        return;
      }
      await cmdList(namespace);
      break;
    }
    case 'rotate': {
      const [namespace, key] = rest;
      if (!namespace || !key) {
        stderr('Usage: vault rotate <namespace> <key>');
        process.exitCode = 1;
        return;
      }
      await cmdRotate(namespace, key);
      break;
    }
    case 'migrate-legacy': {
      const namespace = rest[0];
      if (!namespace) {
        stderr('Usage: vault migrate-legacy <namespace>');
        process.exitCode = 1;
        return;
      }
      await cmdMigrateLegacy(namespace);
      break;
    }
    default: {
      stderr('Usage: sudo vault <command> [args]');
      stderr('Commands:');
      stderr('  import-env <namespace>        Import well-known env vars into vault');
      stderr('  list <namespace>              List key names in namespace');
      stderr('  rotate <namespace> <key>      Re-encrypt a key with a fresh nonce');
      stderr('  migrate-legacy <namespace>    Migrate v1 static-salt namespace to v2 format');
      if (command !== undefined) process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Direct invocation entrypoint
// ---------------------------------------------------------------------------

// Allow running as: node vault-cli.js <args>
// Do not run when imported as a module (for testing)
const isMain = process.argv[1]?.endsWith('vault-cli.ts') ||
  process.argv[1]?.endsWith('vault-cli.js');

if (isMain) {
  const args = process.argv.slice(2);
  runVaultCli(args).catch((err: unknown) => {
    process.stderr.write(`vault-cli error: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
