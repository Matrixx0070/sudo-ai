/**
 * @file grok-web-session-manager.ts
 * @description GW3 — long-term manager for a captured grok.com web session.
 *
 * Mirrors src/llm/xai-oauth-manager.ts (singleton accessor, DATA_DIR
 * persistence, 0600 atomic writes, needs-relogin discipline, secrets never
 * logged) but the credential is a captured BROWSER session, not an OAuth token:
 * a grok.com Cookie header + User-Agent (+ an x-statsig-id for the video lane).
 *
 * Health/refresh model (see docs/grok-web-imagine-protocol.md §7):
 *   - `sso`/`sso-rw`  = the long-lived login (weeks).
 *   - `cf_clearance`/`__cf_bm` = short-lived Cloudflare clearance (hours/minutes)
 *     that a brief headless spin-up re-issues on demand (GW4).
 *   - `x-statsig-id` = client-JS token the video lane needs; captured at spin-up,
 *     reusable within a window, re-captured on an app-chat 403.
 *
 * This module owns persistence + health + the refresh STATE MACHINE. The actual
 * headless capture/refresh is injected (the `refresher` seam) so GW3 stays pure
 * and unit-testable with no browser and no network; GW4 wires the real one.
 *
 * Cookie/statsig values are NEVER logged — lengths/booleans only.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { writeFileAtomic } from '../core/shared/atomic-write.js';
import { createLogger } from '../core/shared/logger.js';
import {
  callGrokWebBridge,
  type GrokWebResponse,
  type GrokWebCreds,
} from './grok-web-bridge.js';

const log = createLogger('llm:grok-web-session');

const DEFAULT_STORE_PATH = path.join(DATA_DIR, 'grok-web-session.json');

/** cf_clearance staleness horizon for a proactive probe (informational). */
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** On-disk session (0600). Secrets: `cookie`, `statsigId`. */
export interface GrokWebSession {
  /** Full grok.com Cookie header (all cookies verbatim). */
  cookie: string;
  /** Captured User-Agent — must match on replay. */
  userAgent: string;
  /** x-statsig-id for the video lane (app-chat). Optional; re-captured on 403. */
  statsigId?: string;
  /** ISO 8601 — when this session was captured/last refreshed. */
  capturedAt: string;
  /** Durable browser profile dir used to refresh (GW4). */
  profileDir?: string;
  /** Set when `sso` is dead (login page/401) — a human must re-run setup. */
  needsRelogin?: boolean;
}

export interface GrokWebStatus {
  connected: boolean;
  capturedAt?: string;
  needsRelogin?: boolean;
  hasStatsig?: boolean;
}

/**
 * Raised when the underlying `sso` login is dead. NEVER retried automatically —
 * the operator must re-run the web-session setup (same one-time flow as the
 * xAI OAuth device login).
 */
export class GrokWebReloginRequiredError extends Error {
  readonly code = 'GROK_WEB_RELOGIN_REQUIRED';
  constructor() {
    super('grok.com web session login (sso) is no longer valid — re-run `sudo-ai grok websession setup` to reconnect.');
    this.name = 'GrokWebReloginRequiredError';
  }
}

/**
 * The headless capture/refresh seam (GW4 provides the real implementation).
 * Given the saved profile dir (may be undefined for a fresh capture), open a
 * durable-profile browser, obtain fresh cookies + UA + statsig, and return them.
 * Throws GrokWebReloginRequiredError when `sso` is dead.
 */
export type GrokWebRefresher = (profileDir: string | undefined) => Promise<{
  cookie: string;
  userAgent: string;
  statsigId?: string;
  profileDir?: string;
}>;

/** Injectable seams — real values by default, overridden in tests. */
export interface GrokWebDeps {
  bridge: typeof callGrokWebBridge;
  now: () => number;
  /** Default refresher throws "not configured"; GW4 injects the browser one. */
  refresher: GrokWebRefresher;
}

const defaultDeps: GrokWebDeps = {
  bridge: callGrokWebBridge,
  now: () => Date.now(),
  refresher: () => {
    throw new Error('GrokWeb refresher not configured (GW4 wires the headless browser refresh)');
  },
};

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class GrokWebSessionManager {
  private readonly storePath: string;
  private readonly deps: GrokWebDeps;
  /** In-process single-flight refresh — concurrent callers share one refresh. */
  private refreshPromise: Promise<GrokWebSession> | null = null;

  constructor(storePath: string = DEFAULT_STORE_PATH, deps: Partial<GrokWebDeps> = {}) {
    this.storePath = storePath;
    this.deps = { ...defaultDeps, ...deps };
  }

  // ----- persistence ------------------------------------------------------

  /** Read fresh from disk every call (another process may have refreshed). */
  loadSession(): GrokWebSession | null {
    try {
      if (!existsSync(this.storePath)) return null;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Record<string, unknown>;
      const cookie = raw['cookie'];
      const userAgent = raw['userAgent'];
      if (typeof cookie !== 'string' || !cookie) {
        log.warn({ path: this.storePath }, 'grok-web session store incomplete — ignoring');
        return null;
      }
      const s: GrokWebSession = {
        cookie,
        userAgent: typeof userAgent === 'string' && userAgent ? userAgent : DEFAULT_UA,
        capturedAt: typeof raw['capturedAt'] === 'string' ? raw['capturedAt'] : new Date(0).toISOString(),
      };
      if (typeof raw['statsigId'] === 'string') s.statsigId = raw['statsigId'];
      if (typeof raw['profileDir'] === 'string') s.profileDir = raw['profileDir'];
      if (raw['needsRelogin'] === true) s.needsRelogin = true;
      return s;
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to load grok-web session store');
      return null;
    }
  }

  /** Atomic 0600 write — cookies are secrets. */
  saveSession(session: GrokWebSession): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    writeFileAtomic(this.storePath, JSON.stringify(session, null, 2), { mode: 0o600 });
    log.debug(
      {
        path: this.storePath,
        cookieLen: session.cookie.length,
        hasStatsig: typeof session.statsigId === 'string',
        needsRelogin: session.needsRelogin === true,
      },
      'grok-web session persisted',
    );
  }

  /** Persist a freshly-captured session (GW4 setup calls this). */
  capture(session: Omit<GrokWebSession, 'capturedAt'> & { capturedAt?: string }): void {
    this.saveSession({ ...session, capturedAt: session.capturedAt ?? new Date(this.deps.now()).toISOString() });
  }

  private creds(session: GrokWebSession): GrokWebCreds {
    const c: GrokWebCreds = { cookie: session.cookie, userAgent: session.userAgent };
    if (session.statsigId) c.statsigId = session.statsigId;
    return c;
  }

  // ----- health -----------------------------------------------------------

  /** Raw quota_info probe via the bridge. Null session → not-connected error. */
  async probe(): Promise<GrokWebResponse> {
    const session = this.loadSession();
    if (!session) return { ok: false, errorClass: 'relogin', detail: 'no session captured' };
    if (session.needsRelogin) return { ok: false, errorClass: 'relogin', detail: 'needsRelogin set' };
    return this.deps.bridge({ op: 'probe' }, this.creds(session));
  }

  /** True when quota_info returns 200 (session valid + Cloudflare passed). */
  async isHealthy(): Promise<boolean> {
    const r = await this.probe();
    return r.ok === true && (r.status ?? 0) === 200;
  }

  /**
   * Return a session that is currently healthy, refreshing once on a Cloudflare
   * failure. Throws GrokWebReloginRequiredError when `sso` is dead.
   */
  async ensureHealthy(): Promise<GrokWebSession> {
    const session = this.loadSession();
    if (!session) throw new GrokWebReloginRequiredError();
    if (session.needsRelogin) throw new GrokWebReloginRequiredError();

    const r = await this.probe();
    if (r.ok) return session;
    if (r.errorClass === 'relogin') {
      this.markRelogin(session);
      throw new GrokWebReloginRequiredError();
    }
    // cloudflare / http_error / bridge_error → try a single headless refresh.
    if (r.errorClass === 'cloudflare' || r.errorClass === 'http_error' || r.errorClass === 'bridge_error') {
      const refreshed = await this.refresh();
      const r2 = await this.deps.bridge({ op: 'probe' }, this.creds(refreshed));
      if (r2.ok) return refreshed;
      if (r2.errorClass === 'relogin') {
        this.markRelogin(refreshed);
        throw new GrokWebReloginRequiredError();
      }
      throw new Error(`grok-web session unhealthy after refresh: ${r2.errorClass ?? 'unknown'}`);
    }
    throw new Error(`grok-web probe failed: ${r.errorClass ?? 'unknown'}`);
  }

  // ----- refresh (GW4-backed) --------------------------------------------

  /**
   * Headless-refresh the Cloudflare clearance (and statsig) via the injected
   * refresher, single-flighted. Persists the merged session 0600. On a dead
   * `sso` the refresher throws GrokWebReloginRequiredError → persist the flag.
   */
  async refresh(): Promise<GrokWebSession> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<GrokWebSession> {
    const prev = this.loadSession();
    try {
      const fresh = await this.deps.refresher(prev?.profileDir);
      const next: GrokWebSession = {
        cookie: fresh.cookie,
        userAgent: fresh.userAgent,
        capturedAt: new Date(this.deps.now()).toISOString(),
      };
      // statsig/profileDir: prefer fresh, fall back to previous.
      const statsig = fresh.statsigId ?? prev?.statsigId;
      if (statsig) next.statsigId = statsig;
      const profileDir = fresh.profileDir ?? prev?.profileDir;
      if (profileDir) next.profileDir = profileDir;
      this.saveSession(next);
      log.info({ cookieLen: next.cookie.length, hasStatsig: typeof next.statsigId === 'string' }, 'grok-web session refreshed');
      return next;
    } catch (err) {
      if (err instanceof GrokWebReloginRequiredError) {
        if (prev) this.markRelogin(prev);
        throw err;
      }
      throw err;
    }
  }

  private markRelogin(session: GrokWebSession): void {
    this.saveSession({ ...session, needsRelogin: true });
    log.error('grok-web session sso dead — re-login required');
  }

  // ----- introspection ----------------------------------------------------

  /** Connection status — NEVER includes cookie/statsig material. */
  status(): GrokWebStatus {
    const s = this.loadSession();
    if (!s) return { connected: false };
    if (s.needsRelogin) return { connected: false, needsRelogin: true };
    const out: GrokWebStatus = { connected: true, hasStatsig: typeof s.statsigId === 'string' };
    if (s.capturedAt) out.capturedAt = s.capturedAt;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singleton: GrokWebSessionManager | null = null;

/** Process-wide manager over <DATA_DIR>/grok-web-session.json, created lazily. */
export function getGrokWebSessionManager(): GrokWebSessionManager {
  if (!singleton) singleton = new GrokWebSessionManager();
  return singleton;
}

/** Reset the singleton — for tests only. */
export function __resetGrokWebSessionManager(): void {
  singleton = null;
}
