/**
 * @file xai-oauth-manager.ts
 * @description xAI subscription OAuth (device flow) connector — Phase 1 (auth).
 *
 * Modeled on src/llm/claude-oauth-manager.ts (singleton accessor,
 * data-dir persistence, refresh discipline, logger usage) but NOT legacy:
 * this is the forward-looking xai-oauth provider's token manager.
 *
 * OAuth constants extracted from the reference implementation
 * (NousResearch/hermes-agent hermes_cli/auth.py) — never invented — and
 * validated live by the Phase-0 probe (scripts/xai-oauth-probe.mts) on
 * 2026-07-14:
 *   issuer     https://auth.x.ai
 *   discovery  /.well-known/openid-configuration (device_authorization_endpoint
 *              + token_endpoint resolved at runtime, cached in-process)
 *   client_id  b1a00492-073a-47ea-816f-4c329264a828
 *   scope      "openid profile email offline_access grok-cli:access api:access"
 *   grant      urn:ietf:params:oauth:grant-type:device_code
 *   access tokens last ~6h.
 *
 * CRITICAL INVARIANT — xAI ROTATES the refresh token on EVERY refresh. Two
 * processes refreshing concurrently invalidate each other's refresh token, so
 * every refresh runs under BOTH:
 *   1. a cross-process file lock (`xai-oauth.json.lock`, O_EXCL create,
 *      pid+timestamp payload, stale-steal after 30s, poll 100ms up to 10s), and
 *   2. an in-process single-flight promise (concurrent callers in the same
 *      process await the same refresh).
 * Rotated tokens are PERSISTED (atomic tmp+rename, 0600) BEFORE the new access
 * token is returned to any caller (write-then-use).
 *
 * REFRESH SKEW — deliberate deviation from the operator plan's 60s: we refresh
 * when within 3600s (1h) of expiry. hermes learned that a 60s skew is too
 * narrow for ~6h tokens combined with gateway/cron cadence (a token can be
 * handed out "valid" and expire mid-request or between scheduler ticks); a 1h
 * buffer keeps ~5h of guaranteed validity per refresh while making expiry
 * races practically impossible.
 *
 * Tokens are NEVER logged — lengths/booleans only.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { writeFileAtomic } from '../core/shared/atomic-write.js';
import { createLogger } from '../core/shared/logger.js';
import type { XaiModelEntry } from './xai-models.js';

const log = createLogger('llm:xai-oauth');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const DEFAULT_STORE_PATH = path.join(DATA_DIR, 'xai-oauth.json');

/**
 * Refresh when within this many seconds of expiry. See file header: deliberate
 * 3600s (not the plan's 60s) — 60s is too narrow for ~6h tokens + cron cadence.
 *
 * This is a CEILING: the effective skew is min(REFRESH_SKEW_SEC, lifetime/4)
 * — see effectiveSkewSec(). A fixed 3600s skew on a short-lived token (≤1h)
 * would mark every token stale on arrival and refresh on every request.
 */
const REFRESH_SKEW_SEC = 3600;

/** Access-token lifetime assumed when the token endpoint omits expires_in (~6h). */
const DEFAULT_TOKEN_LIFETIME_SEC = 21_600;

/** Cross-process lock tuning. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 10_000;

/** Device-login total polling cap (15 min). */
const DEVICE_POLL_CAP_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * On-disk store shape. The Phase-0 probe wrote {access_token, refresh_token,
 * token_type, expires_in, scope, obtained_at} WITHOUT expires_at — a missing
 * expires_at is treated as expired-now, so the first use refreshes and migrates
 * the file to this shape. Unknown keys from older writers are dropped on the
 * next persist (gentle migration).
 */
export interface XaiOAuthStore {
  access_token: string;
  refresh_token: string;
  /** ISO 8601 — computed from expires_in at write time. */
  expires_at?: string;
  /** ISO 8601 — when this token set was obtained. */
  obtained_at?: string;
  /** Set when the refresh token was rejected (invalid_grant) — re-login needed. */
  needs_relogin?: boolean;
  /**
   * GP4 picker state — persisted IN the oauth cred store (mirror claude-oauth):
   * the user-picked default model id for the `xai-oauth` method. When unset the
   * provider falls back to the first cached model.
   */
  defaultModel?: string;
  /** Cached live model list (from XaiModelDiscovery.refresh('oauth')). */
  models?: XaiModelEntry[];
  /** ms epoch when `models` was cached — used to decide staleness. */
  modelsFetchedAt?: number;
}

export interface XaiOAuthStatus {
  connected: boolean;
  expiresAt?: string;
  needsRelogin?: boolean;
}

interface DiscoveryDoc {
  device_authorization_endpoint: string;
  token_endpoint: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/** Injectable seams — real values by default, overridden in tests. */
export interface XaiOAuthDeps {
  fetch: typeof fetch;
  /** Millisecond sleep. */
  sleep: (ms: number) => Promise<void>;
  /** Millisecond epoch clock. */
  now: () => number;
}

/**
 * Typed error: the stored refresh token is dead (invalid_grant) or the store
 * was previously marked needs_relogin. NEVER retried automatically — the
 * operator must run `sudo-ai xai-oauth login`.
 */
export class XaiOAuthReloginRequiredError extends Error {
  readonly code = 'XAI_OAUTH_RELOGIN_REQUIRED';
  constructor() {
    super(
      'xAI OAuth refresh token is no longer valid (invalid_grant) — run `sudo-ai xai-oauth login` to reconnect.',
    );
    this.name = 'XaiOAuthReloginRequiredError';
  }
}

const defaultDeps: XaiOAuthDeps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// XaiOAuthManager
// ---------------------------------------------------------------------------

export class XaiOAuthManager {
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly deps: XaiOAuthDeps;
  /** In-process OIDC discovery cache. */
  private discoveryPromise: Promise<DiscoveryDoc> | null = null;
  /** In-process single-flight refresh — concurrent callers share one refresh. */
  private refreshPromise: Promise<string> | null = null;

  constructor(storePath: string = DEFAULT_STORE_PATH, deps: Partial<XaiOAuthDeps> = {}) {
    this.storePath = storePath;
    this.lockPath = `${storePath}.lock`;
    this.deps = { ...defaultDeps, ...deps };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Read the store fresh from disk on every call — another PROCESS may have
   * rotated the tokens since we last looked (see the rotation invariant).
   * Tolerates the probe's shape (extra keys, no expires_at).
   */
  private loadStore(): XaiOAuthStore | null {
    try {
      if (!existsSync(this.storePath)) return null;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Record<string, unknown>;
      const access = raw['access_token'];
      const refresh = raw['refresh_token'];
      if (typeof access !== 'string' || typeof refresh !== 'string' || !access || !refresh) {
        log.warn({ path: this.storePath }, 'xAI OAuth store incomplete — ignoring');
        return null;
      }
      const store: XaiOAuthStore = { access_token: access, refresh_token: refresh };
      if (typeof raw['expires_at'] === 'string') store.expires_at = raw['expires_at'];
      if (typeof raw['obtained_at'] === 'string') store.obtained_at = raw['obtained_at'];
      if (raw['needs_relogin'] === true) store.needs_relogin = true;
      if (typeof raw['defaultModel'] === 'string') store.defaultModel = raw['defaultModel'];
      if (Array.isArray(raw['models'])) store.models = raw['models'] as XaiModelEntry[];
      if (typeof raw['modelsFetchedAt'] === 'number') store.modelsFetchedAt = raw['modelsFetchedAt'];
      return store;
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to load xAI OAuth store');
      return null;
    }
  }

  /** Atomic (tmp+rename) 0600 write — a torn write would kill the provider. */
  private saveStore(store: XaiOAuthStore): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    writeFileAtomic(this.storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
    log.debug(
      { path: this.storePath, accessLen: store.access_token.length, needsRelogin: store.needs_relogin === true },
      'xAI OAuth store persisted',
    );
  }

  /**
   * Effective refresh skew for a store: min(REFRESH_SKEW_SEC, floor(lifetime/4)),
   * where lifetime is the token's expires_in at persist time, derived from the
   * obtained_at → expires_at span. Guards against refresh-per-request churn if
   * xAI ever issues short tokens: a 30-min token gets a 450s skew, not 3600s
   * (which would mark it stale on arrival, burning a rotation every call).
   * Unknown lifetime (no/invalid obtained_at) → the full REFRESH_SKEW_SEC.
   */
  private effectiveSkewSec(store: XaiOAuthStore): number {
    if (store.obtained_at !== undefined && store.expires_at !== undefined) {
      const obtainedMs = Date.parse(store.obtained_at);
      const expMs = Date.parse(store.expires_at);
      if (Number.isFinite(obtainedMs) && Number.isFinite(expMs) && expMs > obtainedMs) {
        const lifetimeSec = Math.floor((expMs - obtainedMs) / 1000);
        return Math.min(REFRESH_SKEW_SEC, Math.floor(lifetimeSec / 4));
      }
    }
    return REFRESH_SKEW_SEC;
  }

  /**
   * A token is usable when expires_at exists AND is more than the effective
   * skew away (see effectiveSkewSec). Missing expires_at (probe-shaped file)
   * = expired-now by design.
   */
  private isFresh(store: XaiOAuthStore): boolean {
    if (!store.expires_at) return false;
    const expMs = Date.parse(store.expires_at);
    if (!Number.isFinite(expMs)) return false;
    return expMs - this.deps.now() > this.effectiveSkewSec(store) * 1000;
  }

  // -------------------------------------------------------------------------
  // OIDC discovery (cached in-process)
  // -------------------------------------------------------------------------

  private discover(): Promise<DiscoveryDoc> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = (async (): Promise<DiscoveryDoc> => {
        const res = await this.deps.fetch(DISCOVERY_URL);
        if (!res.ok) throw new Error(`xAI OIDC discovery failed: HTTP ${res.status}`);
        const doc = (await res.json()) as Partial<DiscoveryDoc>;
        if (
          typeof doc.device_authorization_endpoint !== 'string' ||
          typeof doc.token_endpoint !== 'string'
        ) {
          throw new Error('xAI OIDC discovery document missing endpoints');
        }
        log.debug('xAI OIDC discovery resolved');
        return doc as DiscoveryDoc;
      })().catch((err: unknown) => {
        // Don't cache a failure — allow the next caller to retry discovery.
        this.discoveryPromise = null;
        throw err;
      });
    }
    return this.discoveryPromise;
  }

  // -------------------------------------------------------------------------
  // Cross-process file lock
  // -------------------------------------------------------------------------

  /**
   * Acquire `xai-oauth.json.lock` via O_EXCL create ('wx'). Payload is
   * {pid, ts} for diagnostics + staleness. A lock older than 30s is stolen
   * (with a warning — its owner crashed or hung). Polls every 100ms for up
   * to 10s, then throws.
   */
  private async acquireLock(): Promise<void> {
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = this.deps.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, ts: this.deps.now() }));
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // Lock held — stale-steal if its timestamp (payload ts, falling back to
      // mtime) is older than 30s.
      const age = this.lockAgeMs();
      if (age !== null && age > LOCK_STALE_MS) {
        log.warn({ path: this.lockPath, ageMs: age }, 'Stealing stale xAI OAuth lock');
        try {
          unlinkSync(this.lockPath);
        } catch {
          /* raced with the owner's release — loop retries */
        }
        continue;
      }
      if (this.deps.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_WAIT_MS}ms waiting for xAI OAuth lock at ${this.lockPath}`,
        );
      }
      await this.deps.sleep(LOCK_POLL_MS);
    }
  }

  /** Age of the current lock in ms, or null if it vanished. */
  private lockAgeMs(): number | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { ts?: unknown };
      if (typeof parsed.ts === 'number') return this.deps.now() - parsed.ts;
    } catch {
      /* unreadable/partial payload — fall through to mtime */
    }
    try {
      return this.deps.now() - statSync(this.lockPath).mtimeMs;
    } catch {
      return null; // released between checks
    }
  }

  private releaseLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to release xAI OAuth lock (already gone?)');
    }
  }

  // -------------------------------------------------------------------------
  // Access token + refresh
  // -------------------------------------------------------------------------

  /**
   * Return a valid access token, refreshing when within the effective skew
   * (min(3600s, lifetime/4) — see effectiveSkewSec) of expiry.
   * Returns null when no store exists. Throws XaiOAuthReloginRequiredError
   * when the refresh token is dead — never retries.
   */
  async getAccessToken(): Promise<string | null> {
    const store = this.loadStore();
    if (!store) return null;
    if (store.needs_relogin) throw new XaiOAuthReloginRequiredError();
    if (this.isFresh(store)) return store.access_token;

    // Single-flight: every concurrent in-process caller awaits the same
    // refresh (rotation makes duplicate refreshes mutually destructive).
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshUnderLock().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /** Cross-process-locked refresh. Persists rotated tokens BEFORE returning. */
  private async refreshUnderLock(): Promise<string> {
    await this.acquireLock();
    try {
      // Re-read under the lock — another process may have just refreshed;
      // using its result avoids burning (and invalidating) its refresh token.
      const store = this.loadStore();
      if (!store) throw new Error('xAI OAuth store disappeared during refresh');
      if (store.needs_relogin) throw new XaiOAuthReloginRequiredError();
      if (this.isFresh(store)) return store.access_token;

      const disc = await this.discover();
      const res = await this.deps.fetch(disc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: store.refresh_token,
          client_id: CLIENT_ID,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as TokenResponse;

      if (!res.ok || typeof data.access_token !== 'string') {
        if (data.error === 'invalid_grant') {
          // Refresh token dead. Persist the flag so no process retry-loops,
          // then tell the operator exactly what to run.
          this.saveStore({ ...store, needs_relogin: true });
          log.error('xAI OAuth refresh rejected (invalid_grant) — re-login required');
          throw new XaiOAuthReloginRequiredError();
        }
        throw new Error(`xAI OAuth refresh failed: HTTP ${res.status} error=${data.error ?? 'unknown'}`);
      }

      const nowMs = this.deps.now();
      const next: XaiOAuthStore = {
        access_token: data.access_token,
        // xAI rotates the refresh token on every refresh; keep the old one
        // only if (unexpectedly) none is returned.
        refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : store.refresh_token,
        expires_at: new Date(nowMs + (data.expires_in ?? DEFAULT_TOKEN_LIFETIME_SEC) * 1000).toISOString(),
        obtained_at: new Date(nowMs).toISOString(),
        // Carry the GP4 picker state across a token rotation (JSON.stringify
        // drops the undefined ones) — a refresh must not wipe the user's
        // default model or cached list.
        defaultModel: store.defaultModel,
        models: store.models,
        modelsFetchedAt: store.modelsFetchedAt,
      };
      // WRITE-THEN-USE: persist the rotated pair before any caller sees it —
      // a crash after return-but-before-write would strand a dead refresh token.
      this.saveStore(next);
      log.info(
        { accessLen: next.access_token.length, rotated: typeof data.refresh_token === 'string' },
        'xAI OAuth token refreshed',
      );
      return next.access_token;
    } finally {
      this.releaseLock();
    }
  }

  // -------------------------------------------------------------------------
  // Device login (probe flow, productionized)
  // -------------------------------------------------------------------------

  /**
   * Run the OAuth device flow: discovery → device code → surface
   * verification_uri_complete + user_code (callback or stdout) → poll the
   * token endpoint honoring `interval` and `slow_down` (total cap 15 min)
   * → persist 0600.
   */
  async deviceLogin(opts?: { onCode?: (url: string, code: string) => void }): Promise<void> {
    const disc = await this.discover();

    const devRes = await this.deps.fetch(disc.device_authorization_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
    });
    if (!devRes.ok) {
      throw new Error(`xAI device authorization failed: HTTP ${devRes.status}`);
    }
    const dev = (await devRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      interval?: number;
    };
    const url = dev.verification_uri_complete ?? dev.verification_uri;
    if (opts?.onCode) {
      opts.onCode(url, dev.user_code);
    } else {
      console.log(`\n  Open:  ${url}`);
      console.log(`  Code:  ${dev.user_code}\n`);
    }

    let intervalS = Math.max(dev.interval ?? 5, 1);
    const deadline = this.deps.now() + DEVICE_POLL_CAP_MS;
    while (this.deps.now() < deadline) {
      await this.deps.sleep(intervalS * 1000);
      const res = await this.deps.fetch(disc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: dev.device_code,
          client_id: CLIENT_ID,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as TokenResponse;
      if (res.ok && typeof data.access_token === 'string' && typeof data.refresh_token === 'string') {
        const nowMs = this.deps.now();
        this.saveStore({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: new Date(nowMs + (data.expires_in ?? DEFAULT_TOKEN_LIFETIME_SEC) * 1000).toISOString(),
          obtained_at: new Date(nowMs).toISOString(),
        });
        log.info({ accessLen: data.access_token.length }, 'xAI OAuth device login complete');
        return;
      }
      const err = String(data.error ?? '');
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        intervalS += 5;
        continue;
      }
      throw new Error(`xAI device login failed: HTTP ${res.status} error=${err || 'unknown'}`);
    }
    throw new Error('xAI device login timed out after 15 minutes without approval');
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Connection status — NEVER includes token material. */
  status(): XaiOAuthStatus {
    const store = this.loadStore();
    if (!store) return { connected: false };
    if (store.needs_relogin) return { connected: false, needsRelogin: true };
    const out: XaiOAuthStatus = { connected: true };
    if (store.expires_at) out.expiresAt = store.expires_at;
    return out;
  }

  // -------------------------------------------------------------------------
  // Model cache + default selection (GP4 — mirror claude-oauth-manager)
  // -------------------------------------------------------------------------

  /** Cached model list for the oauth method (may be empty). */
  listModels(): XaiModelEntry[] {
    return this.loadStore()?.models ?? [];
  }

  /**
   * Resolve which oauth model is the default: the user-picked id when it is
   * still present in (or there is no) cached list, else the first cached model,
   * else null. Never returns a stale id that dropped out of the live list.
   */
  getDefaultModel(): string | null {
    const store = this.loadStore();
    if (!store) return null;
    const cached = store.models ?? [];
    const picked = store.defaultModel;
    if (picked && (cached.length === 0 || cached.some((m) => m.id === picked))) return picked;
    return cached[0]?.id ?? null;
  }

  /**
   * Persist the picked default. Returns false when the id is not in the cached
   * list (caller should refresh + surface the error). Preserves credentials.
   */
  setDefaultModel(id: string): boolean {
    const store = this.loadStore();
    if (!store) return false;
    const cached = store.models ?? [];
    if (cached.length > 0 && !cached.some((m) => m.id === id)) {
      log.warn({ id }, 'xai-oauth setDefaultModel: id not in cached model list');
      return false;
    }
    this.saveStore({ ...store, defaultModel: id });
    log.info({ id }, 'xai-oauth default model set');
    return true;
  }

  /** Cache a freshly-discovered model list into the oauth cred store. */
  setModels(models: XaiModelEntry[]): void {
    const store = this.loadStore();
    if (!store) return;
    this.saveStore({ ...store, models, modelsFetchedAt: this.deps.now() });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: XaiOAuthManager | null = null;

/** Process-wide manager over <DATA_DIR>/xai-oauth.json, created lazily. */
export function getXaiOAuthManager(): XaiOAuthManager {
  if (!singleton) singleton = new XaiOAuthManager();
  return singleton;
}

/** Reset the singleton — for tests only. */
export function __resetXaiOAuthManager(): void {
  singleton = null;
}
