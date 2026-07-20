/**
 * @file xai-models.ts
 * @description GP1 — live model discovery for the two independent Grok
 * providers: `xai-oauth` (subscription seat) and `xai` (metered API key).
 *
 * The account-specific model list is ALWAYS live-queried, never hardcoded —
 * Frank's OAuth seat returns `grok-4.5`/`grok-build`; other accounts and tiers
 * differ. Two endpoints, two credential stores, two billing semantics:
 *
 *   method 'oauth'  → GET cli-chat-proxy.grok.com/v1/models  (subscription seat,
 *                     grok-cli client headers required; credential = the OAuth
 *                     access token from data/xai-oauth.json)
 *   method 'apikey' → GET api.x.ai/v1/models                 (metered API; the
 *                     credential = XAI_API_KEY, a store fully independent of the
 *                     OAuth token — switching methods never clobbers the other)
 *
 * Verified live by Fable 2026-07-20 (HTTP 200) for the OAuth proxy path; the
 * api.x.ai path is the documented standard xAI models endpoint (mark UNVERIFIED
 * until run with a real key). No LLM spend — a plain GET liveness/list call.
 * The credential is NEVER logged (lengths/booleans only).
 */

import { createLogger } from '../core/shared/logger.js';
import { XAI_CLI_PROXY_MODELS_URL, XAI_MODELS_URL } from './endpoints.js';

const log = createLogger('llm:xai-models');

/** Which independent Grok provider a discovery call targets. */
export type XaiAuthMethod = 'oauth' | 'apikey';

/** Default grok-cli client version advertised to the subscription proxy. */
const DEFAULT_GROK_CLI_VERSION = '0.2.22';
/** grok-cli client identifier the proxy expects (source: installed binary). */
const GROK_CLIENT_IDENTIFIER = 'grok-shell';
/** Cache TTL for `list()` before it re-fetches (manual `refresh()` bypasses). */
const MODELS_TTL_MS = 5 * 60 * 1000;

/**
 * A normalized model entry — the same shape regardless of which endpoint (or
 * response schema) produced it. Unknown fields degrade gracefully to null/false
 * rather than being invented.
 */
export interface XaiModelEntry {
  /** Model id used in the brain model string, e.g. `xai-oauth/grok-build`. */
  id: string;
  /** Human display name; falls back to `id` when the endpoint omits one. */
  name: string;
  /** Context window in tokens, or null when the endpoint doesn't report it. */
  contextWindow: number | null;
  /** Backend family the model runs on (e.g. 'responses'), or null. */
  backend: string | null;
  /** Whether the model accepts a reasoning-effort parameter. */
  supportsReasoningEffort: boolean;
  /** Enumerated reasoning-effort levels, when the endpoint lists them. */
  reasoningEfforts: string[];
  /**
   * Cost class, derived from the method — the seat is subscription-covered
   * ($0 to the user); the API key is pay-per-token. Surfaced so a picker can
   * make the distinction visible.
   */
  billing: 'subscription' | 'metered';
}

/**
 * Raised when discovery is attempted without a stored credential for the
 * requested method. Carries the method so the caller can print the exact
 * onboarding command (`sudo-ai xai-oauth login` vs. setting XAI_API_KEY).
 */
export class XaiNotConnectedError extends Error {
  readonly code = 'XAI_NOT_CONNECTED';
  constructor(readonly method: XaiAuthMethod) {
    super(
      method === 'oauth'
        ? 'xAI OAuth not connected — run `sudo-ai xai-oauth login`.'
        : 'xAI API key not set — set XAI_API_KEY (console.x.ai → API Keys).',
    );
    this.name = 'XaiNotConnectedError';
  }
}

/** Injectable seams — real implementations by default, overridden in tests. */
export interface XaiModelsDeps {
  fetch: typeof fetch;
  /**
   * Resolve the credential (bearer token) for a method, or null when the
   * corresponding store is empty. The two methods read TWO INDEPENDENT stores.
   */
  getCredential: (method: XaiAuthMethod) => Promise<string | null>;
  /** grok-cli version header value (env-tunable in the default deps). */
  cliVersion: () => string;
  /** Millisecond epoch clock. */
  now: () => number;
}

const defaultDeps: XaiModelsDeps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  getCredential: async (method) => {
    if (method === 'oauth') {
      const { getXaiOAuthManager } = await import('./xai-oauth-manager.js');
      return getXaiOAuthManager().getAccessToken();
    }
    const { getXaiApiKeyManager } = await import('./xai-apikey-manager.js');
    return getXaiApiKeyManager().getApiKey();
  },
  cliVersion: () => process.env['SUDO_GROK_CLI_VERSION']?.trim() || DEFAULT_GROK_CLI_VERSION,
  now: () => Date.now(),
};

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
  api_backend?: unknown;
  supports_reasoning_effort?: unknown;
  reasoning_efforts?: unknown;
}

/** Normalize one raw entry from either endpoint into an XaiModelEntry. */
function normalize(raw: RawModel, method: XaiAuthMethod): XaiModelEntry | null {
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    contextWindow: typeof raw.context_window === 'number' ? raw.context_window : null,
    backend: typeof raw.api_backend === 'string' ? raw.api_backend : null,
    supportsReasoningEffort: raw.supports_reasoning_effort === true,
    reasoningEfforts: Array.isArray(raw.reasoning_efforts)
      ? raw.reasoning_efforts.filter((e): e is string => typeof e === 'string')
      : [],
    billing: method === 'oauth' ? 'subscription' : 'metered',
  };
}

interface CacheEntry {
  models: XaiModelEntry[];
  fetchedAt: number;
}

/**
 * Live model discovery for the two Grok providers. Holds a per-method
 * in-memory cache; `list()` serves it (fetching on first use or after TTL),
 * `refresh()` forces a live fetch. No re-auth is performed here — the
 * credential comes from the already-established store via `getCredential`.
 */
export class XaiModelDiscovery {
  private readonly deps: XaiModelsDeps;
  private readonly cache = new Map<XaiAuthMethod, CacheEntry>();

  constructor(deps: Partial<XaiModelsDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Cached list for a method (possibly empty); never fetches. */
  cached(method: XaiAuthMethod): XaiModelEntry[] {
    return this.cache.get(method)?.models ?? [];
  }

  /**
   * Return the model list for a method — cached when still fresh
   * (< MODELS_TTL_MS), otherwise a live fetch. Throws XaiNotConnectedError when
   * the method's store has no credential.
   */
  async list(method: XaiAuthMethod): Promise<XaiModelEntry[]> {
    const hit = this.cache.get(method);
    if (hit && this.deps.now() - hit.fetchedAt < MODELS_TTL_MS) return hit.models;
    return this.refresh(method);
  }

  /**
   * Force a live fetch for a method, replacing the cache. Throws
   * XaiNotConnectedError (no credential) or a descriptive Error on non-2xx.
   */
  async refresh(method: XaiAuthMethod): Promise<XaiModelEntry[]> {
    const cred = await this.deps.getCredential(method);
    if (!cred) throw new XaiNotConnectedError(method);

    const url = method === 'oauth' ? XAI_CLI_PROXY_MODELS_URL : XAI_MODELS_URL;
    const headers: Record<string, string> = { Authorization: `Bearer ${cred}` };
    if (method === 'oauth') {
      const ver = this.deps.cliVersion();
      headers['x-grok-client-version'] = ver;
      headers['x-grok-client-identifier'] = GROK_CLIENT_IDENTIFIER;
      headers['User-Agent'] = `grok/${ver}`;
    }

    let res: Response;
    try {
      res = await this.deps.fetch(url, { method: 'GET', headers });
    } catch (err) {
      throw new Error(`xAI models fetch network error (${method}): ${String(err)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`xAI models fetch HTTP ${res.status} (${method}): ${body.slice(0, 300)}`);
    }

    const parsed = (await res.json().catch(() => ({}))) as { data?: unknown };
    const rawList = Array.isArray(parsed.data) ? parsed.data : [];
    const models = rawList
      .map((m) => normalize((m ?? {}) as RawModel, method))
      .filter((m): m is XaiModelEntry => m !== null);

    this.cache.set(method, { models, fetchedAt: this.deps.now() });
    log.info({ method, count: models.length }, 'xAI models refreshed');
    return models;
  }
}

// ---------------------------------------------------------------------------
// Credential seam (GP2) + singleton
// ---------------------------------------------------------------------------

/**
 * GP2 seam: resolve the bearer credential for a Grok method from its OWN store,
 * with the two stores kept fully independent (OAuth token in
 * data/xai-oauth.json; API key in XAI_API_KEY). Returns null when the store is
 * empty. Exposed for reuse by onboarding/picker surfaces so credential
 * resolution lives in exactly one place.
 */
export async function getGrokCredential(method: XaiAuthMethod): Promise<string | null> {
  return defaultDeps.getCredential(method);
}

let singleton: XaiModelDiscovery | null = null;

/** Process-wide discovery instance, created lazily. */
export function getXaiModelDiscovery(): XaiModelDiscovery {
  if (!singleton) singleton = new XaiModelDiscovery();
  return singleton;
}

/** Reset the singleton — for tests only. */
export function __resetXaiModelDiscovery(): void {
  singleton = null;
}
