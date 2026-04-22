/**
 * @file security/vault-credentials.ts
 * @description MCP-URL-bound credential store on top of the existing AES-GCM vault.
 *
 * Credential types:
 *   mcp_oauth  — access_token + refresh_token + expires_at + token_url + client_id + client_secret
 *   static_bearer — token
 *
 * Invariant: one active (non-archived) credential per mcp_server_url per namespace.
 *
 * Secret fields (access_token, refresh_token, client_secret, token) are stored
 * via vault.set() — WRITE-ONLY from the API perspective.  Only metadata is returned
 * by list/get REST endpoints.  getCredential() decrypts in-memory only.
 *
 * OAuth refresh daemon: runs every 60 s, refreshes any credential whose
 * expires_at < now + 5 min.  Token swap is atomic (secrets first, then metadata).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { vault } from './vault.js';

const log = createLogger('vault-credentials');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Overrideable in tests via SUDO_CRED_VAULT_DIR env var. Falls back to workspace/vault. */
function getCredDir(): string {
  return process.env['SUDO_CRED_VAULT_DIR'] ?? path.resolve('workspace/vault');
}
const REFRESH_INTERVAL_MS = 60_000;
const NEAR_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BODY_LEN = 64 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CredentialType = 'mcp_oauth' | 'static_bearer';

export interface OAuthAuth {
  type: 'mcp_oauth';
  mcp_server_url: string;
  access_token: string;
  expires_at?: string;
  refresh_token?: string;
  token_url?: string;
  client_id?: string;
  client_secret?: string;
}

export interface StaticBearerAuth {
  type: 'static_bearer';
  mcp_server_url: string;
  token: string;
}

export type CredentialAuth = OAuthAuth | StaticBearerAuth;

/** Public-safe metadata (no secret fields). */
export interface CredentialMeta {
  id: string;
  namespace: string;
  type: CredentialType;
  mcp_server_url: string;
  display_name?: string;
  expires_at?: string;
  last_rotated_at?: string;
  created_at: string;
  archived: boolean;
}

/** Decrypted credential returned only in-memory to MCP client code. */
export interface DecryptedCredential extends CredentialMeta {
  access_token?: string;   // mcp_oauth only
  refresh_token?: string;  // mcp_oauth only
  client_id?: string;      // mcp_oauth only
  client_secret?: string;  // mcp_oauth only
  token_url?: string;      // mcp_oauth only
  token?: string;          // static_bearer only
}

/** On-disk metadata file (no secrets). */
interface MetaFile {
  credentials: CredentialMeta[];
}

// ---------------------------------------------------------------------------
// Metadata I/O
// ---------------------------------------------------------------------------

function metaFilePath(namespace: string): string {
  return path.join(getCredDir(), `${namespace}-credentials-meta.json`);
}

function readMeta(namespace: string): MetaFile {
  const fp = metaFilePath(namespace);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw) as MetaFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { credentials: [] };
    throw err;
  }
}

function writeMeta(namespace: string, data: MetaFile): void {
  const fp = metaFilePath(namespace);
  const tmp = fp + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, fp);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* non-fatal */ }
    throw err;
  }
  try { fs.chmodSync(fp, 0o600); } catch { /* non-fatal */ }
}

function secretKey(credId: string): string {
  return `cred:${credId}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/;

function validateNamespace(ns: string): void {
  if (!NAMESPACE_RE.test(ns)) throw new CredentialError(`Invalid namespace: ${ns}`, 400);
}

function validateUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new CredentialError(`mcp_server_url must use http(s) protocol`, 400);
    }
  } catch (e) {
    if (e instanceof CredentialError) throw e;
    throw new CredentialError(`Invalid mcp_server_url: ${url}`, 400);
  }
}

// ---------------------------------------------------------------------------
// SSRF helpers (inlined — mirrors domain-validator.ts isBlockedHost logic)
// ---------------------------------------------------------------------------

const TOKEN_URL_BLOCKED_EXACT = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  '::1',
  '::',
  '0:0:0:0:0:0:0:1',
  '0:0:0:0:0:0:0:0',
]);

function hexPairsToDottedToken(s: string): string | null {
  const parts = s.split(':');
  if (parts.length !== 2) return null;
  try {
    const n1 = parseInt(parts[0]!, 16);
    const n2 = parseInt(parts[1]!, 16);
    if (
      !Number.isFinite(n1) || !Number.isFinite(n2) ||
      n1 < 0 || n1 > 0xffff || n2 < 0 || n2 > 0xffff
    ) return null;
    const b1 = (n1 >> 8) & 0xff;
    const b2 = n1 & 0xff;
    const b3 = (n2 >> 8) & 0xff;
    const b4 = n2 & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  } catch {
    return null;
  }
}

function isBlockedTokenHost(hostname: string): boolean {
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const raw = stripped.toLowerCase().replace(/\.+$/, '');

  if (TOKEN_URL_BLOCKED_EXACT.has(raw)) return true;

  if (raw.includes(':')) {
    const zeroNorm = raw
      .split(':')
      .map(g => (g === '' ? '' : (parseInt(g, 16).toString(16) || '0')))
      .join(':');
    if (TOKEN_URL_BLOCKED_EXACT.has(zeroNorm)) return true;

    if (raw.startsWith('fe80:')) return true;
    if (raw.startsWith('fc') || raw.startsWith('fd')) return true;

    if (raw.startsWith('::ffff:')) {
      const v4part = raw.slice(7);
      const dotted = v4part.includes('.') ? v4part : hexPairsToDottedToken(v4part);
      if (dotted !== null && isBlockedTokenHost(dotted)) return true;
    }

    const colonParts = raw.split(':');
    const lastPart = colonParts[colonParts.length - 1] ?? '';
    if (lastPart.includes('.')) {
      const ipv4Octets = lastPart.split('.').map(Number);
      if (
        ipv4Octets.length === 4 &&
        ipv4Octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)
      ) {
        const [a, b, c, d] = ipv4Octets as [number, number, number, number];
        const hiGroup = ((a << 8) | b).toString(16);
        const loGroup = ((c << 8) | d).toString(16);
        const prefixParts = colonParts.slice(0, -1);
        const expandedParts = [...prefixParts, hiGroup, loGroup];
        const emptyCount = expandedParts.filter(p => p === '').length;
        const neededZeros = 8 - expandedParts.filter(p => p !== '').length;
        const filled: string[] = [];
        let zerosInserted = false;
        for (const part of expandedParts) {
          if (part === '' && !zerosInserted && emptyCount >= 2) {
            for (let i = 0; i < neededZeros; i++) filled.push('0');
            zerosInserted = true;
          } else if (part !== '') {
            filled.push(part);
          }
        }
        while (filled.length < 8) filled.push('0');
        const fullForm = filled.slice(0, 8).join(':');
        if (isBlockedTokenHost(fullForm)) return true;
        if (isBlockedTokenHost(lastPart)) return true;
      }
    }

    return false;
  }

  const octets = raw.split('.').map(Number);
  if (octets.length === 4 && octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  return false;
}

/**
 * Validates a token_url: HTTPS-only, no private/loopback/link-local hosts.
 * Throws CredentialError(400, 'INVALID_TOKEN_URL') on any violation.
 */
function validateTokenUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CredentialError(`Invalid token_url: ${url}`, 400, 'INVALID_TOKEN_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new CredentialError(
      `token_url must use HTTPS protocol (got ${parsed.protocol})`,
      400,
      'INVALID_TOKEN_URL',
    );
  }

  if (isBlockedTokenHost(parsed.hostname)) {
    throw new CredentialError(
      `token_url host is blocked (private/loopback/link-local): ${parsed.hostname}`,
      400,
      'INVALID_TOKEN_URL',
    );
  }
}

export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export class CredentialStore {
  /** Per-namespace async mutex — static so it spans all CredentialStore instances (routes create fresh instances per request). */
  private static _locks: Map<string, Promise<unknown>> = new Map();

  private async _withLock<T>(ns: string, fn: () => Promise<T>): Promise<T> {
    const prior = CredentialStore._locks.get(ns) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    const chained = prior.then(() => next);
    CredentialStore._locks.set(ns, chained);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (CredentialStore._locks.get(ns) === chained) CredentialStore._locks.delete(ns);
    }
  }

  constructor(private readonly ns: string) {
    validateNamespace(ns);
    try { fs.mkdirSync(getCredDir(), { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  }

  /** Add a new credential. Enforces one active cred per mcp_server_url. */
  async add(auth: CredentialAuth, displayName?: string): Promise<CredentialMeta> {
    if (!auth.mcp_server_url) throw new CredentialError('mcp_server_url is required', 400);
    validateUrl(auth.mcp_server_url);

    // Validate token_url before acquiring lock (fail fast; no I/O needed)
    if (auth.type === 'mcp_oauth' && auth.token_url) {
      validateTokenUrl(auth.token_url);
    }

    return this._withLock(this.ns, async () => {
      const meta = readMeta(this.ns);

      // Enforce uniqueness: one active credential per URL per namespace
      const conflict = meta.credentials.find(
        c => c.mcp_server_url === auth.mcp_server_url && !c.archived,
      );
      if (conflict) {
        throw new CredentialError(
          `Active credential already exists for ${auth.mcp_server_url} (id: ${conflict.id}). Archive it first.`,
          409,
          'URL_CONFLICT',
        );
      }

      const id = `cred_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const now = new Date().toISOString();

      // Build secret payload
      let secretPayload: Record<string, string> = {};
      if (auth.type === 'mcp_oauth') {
        if (!auth.access_token) throw new CredentialError('access_token is required for mcp_oauth', 400);
        secretPayload = {
          access_token: auth.access_token,
          ...(auth.refresh_token ? { refresh_token: auth.refresh_token } : {}),
          ...(auth.client_secret ? { client_secret: auth.client_secret } : {}),
          ...(auth.token_url ? { token_url: auth.token_url } : {}),
          ...(auth.client_id ? { client_id: auth.client_id } : {}),
        };
      } else if (auth.type === 'static_bearer') {
        if (!auth.token) throw new CredentialError('token is required for static_bearer', 400);
        secretPayload = { token: auth.token };
      } else {
        throw new CredentialError('Invalid credential type', 400);
      }

      // Store secrets via vault (encrypted at rest)
      await vault.set(this.ns, secretKey(id), JSON.stringify(secretPayload));

      const credMeta: CredentialMeta = {
        id,
        namespace: this.ns,
        type: auth.type,
        mcp_server_url: auth.mcp_server_url,
        ...(displayName ? { display_name: displayName } : {}),
        ...(auth.type === 'mcp_oauth' && auth.expires_at ? { expires_at: auth.expires_at } : {}),
        created_at: now,
        archived: false,
      };

      meta.credentials.push(credMeta);
      writeMeta(this.ns, meta);

      log.info({ id, type: auth.type, url: auth.mcp_server_url }, 'credential added');
      return credMeta;
    });
  }

  /** List active credentials — metadata only, no secrets. */
  list(includeArchived = false): CredentialMeta[] {
    const meta = readMeta(this.ns);
    return includeArchived ? meta.credentials : meta.credentials.filter(c => !c.archived);
  }

  /** Get single credential metadata by id — no secrets. */
  getMeta(id: string): CredentialMeta {
    const meta = readMeta(this.ns);
    const cred = meta.credentials.find(c => c.id === id);
    if (!cred) throw new CredentialError(`Credential not found: ${id}`, 404);
    return cred;
  }

  /**
   * Get decrypted credential IN-MEMORY only (never logged, never returned via REST).
   * Looks up by mcp_server_url — the way MCP client code accesses credentials.
   */
  async getCredential(mcpServerUrl: string): Promise<DecryptedCredential | null> {
    const meta = readMeta(this.ns);
    const cred = meta.credentials.find(c => c.mcp_server_url === mcpServerUrl && !c.archived);
    if (!cred) return null;

    const result = await vault.get(this.ns, secretKey(cred.id), 'mcp-client');
    if (!result) return null;

    let secrets: Record<string, string> = {};
    try { secrets = JSON.parse(result.value) as Record<string, string>; }
    catch { return null; }

    return { ...cred, ...secrets } as DecryptedCredential;
  }

  /** Rotate: replace secret payload for an existing credential. */
  async rotate(id: string, newAuth: Partial<CredentialAuth>): Promise<CredentialMeta> {
    // Validate token_url before acquiring lock (fail fast; no I/O needed)
    const incomingTokenUrl = (newAuth as Record<string, unknown>)['token_url'];
    if (typeof incomingTokenUrl === 'string') {
      validateTokenUrl(incomingTokenUrl);
    }

    return this._withLock(this.ns, async () => {
      const meta = readMeta(this.ns);
      const idx = meta.credentials.findIndex(c => c.id === id);
      if (idx === -1) throw new CredentialError(`Credential not found: ${id}`, 404);
      const cred = meta.credentials[idx]!;
      if (cred.archived) throw new CredentialError('Cannot rotate archived credential', 409);

      // Decrypt current secrets, merge with new values
      const existing = await vault.get(this.ns, secretKey(id), 'rotate');
      let secrets: Record<string, string> = {};
      if (existing) {
        try { secrets = JSON.parse(existing.value) as Record<string, string>; } catch { /* start fresh */ }
      }

      // Merge new values
      const merged = { ...secrets, ...(newAuth as Record<string, string>) };
      // Remove type/mcp_server_url from the secret payload if they leaked in
      delete merged['type']; delete merged['mcp_server_url'];

      await vault.set(this.ns, secretKey(id), JSON.stringify(merged));

      const now = new Date().toISOString();
      const updated = { ...cred, last_rotated_at: now };
      if ('expires_at' in newAuth && (newAuth as OAuthAuth).expires_at) {
        updated.expires_at = (newAuth as OAuthAuth).expires_at;
      }
      meta.credentials[idx] = updated;
      writeMeta(this.ns, meta);

      log.info({ id }, 'credential rotated');
      return updated;
    });
  }

  /** Archive: purge secret, mark archived. */
  async archive(id: string): Promise<CredentialMeta> {
    const meta = readMeta(this.ns);
    const idx = meta.credentials.findIndex(c => c.id === id);
    if (idx === -1) throw new CredentialError(`Credential not found: ${id}`, 404);
    const cred = meta.credentials[idx]!;

    // Purge secret from vault (best-effort — may already be gone)
    try { await vault.delete(this.ns, secretKey(id), 'archive'); }
    catch { /* may not exist */ }

    const updated = { ...cred, archived: true };
    meta.credentials[idx] = updated;
    writeMeta(this.ns, meta);

    log.info({ id }, 'credential archived, secret purged');
    return updated;
  }

  /**
   * Internal: swap access_token (and optionally refresh_token + expires_at) atomically.
   * Used by the OAuth refresh daemon.
   */
  async _atomicTokenSwap(
    id: string,
    newAccessToken: string,
    newRefreshToken: string | undefined,
    newExpiresAt: string | undefined,
  ): Promise<void> {
    const existing = await vault.get(this.ns, secretKey(id), 'oauth-refresh-daemon');
    let secrets: Record<string, string> = {};
    if (existing) {
      try { secrets = JSON.parse(existing.value) as Record<string, string>; } catch { /* use empty */ }
    }
    secrets['access_token'] = newAccessToken;
    if (newRefreshToken) secrets['refresh_token'] = newRefreshToken;

    // Write secrets first — stale metadata is recoverable, stale secrets are not
    await vault.set(this.ns, secretKey(id), JSON.stringify(secrets));

    const meta = readMeta(this.ns);
    const idx = meta.credentials.findIndex(c => c.id === id);
    if (idx !== -1) {
      const now = new Date().toISOString();
      meta.credentials[idx] = {
        ...meta.credentials[idx]!,
        last_rotated_at: now,
        ...(newExpiresAt ? { expires_at: newExpiresAt } : {}),
      };
      writeMeta(this.ns, meta);
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth Refresh Daemon
// ---------------------------------------------------------------------------

/**
 * Scans all credential metadata files in workspace/vault every 60 s.
 * Refreshes any mcp_oauth credential whose expires_at < now + 5 min.
 */
export class OAuthRefreshDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    log.info('OAuth refresh daemon started (interval: 60s)');
    this.timer = setInterval(() => { void this._tick(); }, REFRESH_INTERVAL_MS);
    // Allow process to exit even if timer is running
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('OAuth refresh daemon stopped');
    }
  }

  /** Exposed for testing — runs one refresh sweep. */
  async _tick(): Promise<void> {
    try {
      const files = fs.readdirSync(getCredDir()).filter(f => f.endsWith('-credentials-meta.json'));
      for (const f of files) {
        const ns = f.replace(/-credentials-meta\.json$/, '');
        if (!NAMESPACE_RE.test(ns)) continue;
        await this._refreshNamespace(ns);
      }
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'OAuth daemon tick error');
    }
  }

  private async _refreshNamespace(ns: string): Promise<void> {
    const meta = readMeta(ns);
    const store = new CredentialStore(ns);
    const now = Date.now();

    for (const cred of meta.credentials) {
      if (cred.archived || cred.type !== 'mcp_oauth') continue;
      if (!cred.expires_at) continue;
      if (new Date(cred.expires_at).getTime() > now + NEAR_EXPIRY_MS) continue;

      log.info({ id: cred.id, ns, url: cred.mcp_server_url, expires_at: cred.expires_at }, 'refreshing near-expiry oauth credential');

      try {
        const decrypted = await store.getCredential(cred.mcp_server_url);
        if (!decrypted?.refresh_token || !decrypted.token_url) {
          log.warn({ id: cred.id }, 'cannot refresh: missing refresh_token or token_url');
          continue;
        }
        await this._doRefresh(store, cred.id, decrypted);
      } catch (err: unknown) {
        log.warn({ id: cred.id, err: String(err) }, 'OAuth token refresh failed');
      }
    }
  }

  private async _doRefresh(
    store: CredentialStore,
    id: string,
    cred: DecryptedCredential,
  ): Promise<void> {
    if (!cred.token_url) {
      log.warn({ credId: cred.id }, 'oauth refresh: credential has no token_url — skipping');
      return;
    }
    try {
      validateTokenUrl(cred.token_url);
    } catch (err) {
      log.warn({ credId: cred.id, err: String(err) }, 'oauth refresh: token_url failed runtime validation — skipping');
      return;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token ?? '',
      client_id: cred.client_id ?? '',
    });
    if (cred.client_secret) body.set('client_secret', cred.client_secret);

    const resp = await fetch(cred.token_url ?? '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(body.toString().length) },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`Token endpoint returned ${resp.status}`);
    }

    // Limit response to avoid memory bomb
    const text = await resp.text();
    if (text.length > MAX_BODY_LEN) throw new Error('Token response too large');

    let data: Record<string, unknown>;
    try { data = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error('Token endpoint returned non-JSON'); }

    const newAccessToken = data['access_token'];
    if (typeof newAccessToken !== 'string' || !newAccessToken) {
      throw new Error('Token response missing access_token');
    }

    const newRefreshToken = typeof data['refresh_token'] === 'string' ? data['refresh_token'] : undefined;
    let newExpiresAt: string | undefined;
    if (typeof data['expires_in'] === 'number') {
      newExpiresAt = new Date(Date.now() + data['expires_in'] * 1000).toISOString();
    } else if (typeof data['expires_at'] === 'string') {
      newExpiresAt = data['expires_at'];
    }

    await store._atomicTokenSwap(id, newAccessToken, newRefreshToken, newExpiresAt);
    log.info({ id }, 'OAuth token refreshed successfully');
  }
}

/** Module-level singleton daemon. */
export const oauthRefreshDaemon = new OAuthRefreshDaemon();
