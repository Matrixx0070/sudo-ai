/**
 * cache-affinity.ts — per-session cache-affinity store (opt-in).
 *
 * Resolves the S1 tension from the beat-openclaw campaign (see
 * docs/SPEC_SESSION_CACHE_AFFINITY.md): a session can opt into sticking to ONE
 * conversational provider so its prompt cache stays warm (≥90% cache-read
 * share, matching OpenClaw) WITHOUT disabling SUDO-AI's smart multi-model
 * router by default (the S16 outcome-gated routing lead — a hard "never
 * regress").
 *
 * This module is pure state: a bounded per-session map keyed by sessionId. The
 * router seam lives in brain.ts (`_smartRoute`). Everything here is
 * side-effect-free except the in-memory Map, and the clock is injectable so the
 * TTL/eviction logic is deterministically testable.
 *
 * S16 invariant: `sessionCacheAffinityEnabled()` gates the ENTIRE feature. When
 * SUDO_SESSION_CACHE_AFFINITY is off (default), the brain never calls into this
 * module in a way that changes a routing decision — routing is byte-identical
 * to today. Non-conversational calls (RAG, judge, consciousness — no sessionId)
 * never pin.
 */

/** A single session's pinned conversational provider/model. */
export interface SessionAffinity {
  /** The conversation this pin belongs to. */
  sessionId: string;
  /** Provider-qualified model string, e.g. `xai-oauth/grok-4-fast-non-reasoning`. */
  model: string;
  /** Provider prefix (portion before the first `/`), e.g. `xai-oauth`. */
  provider: string;
  /** Epoch-ms when the pin was recorded. */
  pinnedAt: number;
}

/**
 * Whether per-session cache affinity is enabled globally. Default OFF ⇒ the
 * feature is a true no-op (byte-identical routing). This is the ONLY switch the
 * brain checks before touching the store.
 */
export function sessionCacheAffinityEnabled(): boolean {
  return process.env['SUDO_SESSION_CACHE_AFFINITY'] === '1';
}

/**
 * Optional explicit pin target (skips first-turn discovery). e.g.
 * `xai-oauth/grok-4-fast-non-reasoning`. Unset ⇒ first-turn-winner mode.
 */
export function explicitAffinityProvider(): string | undefined {
  const v = process.env['SUDO_CACHE_AFFINITY_PROVIDER']?.trim();
  return v ? v : undefined;
}

// --- Bounds -----------------------------------------------------------------
// The store is bounded so a long-lived process can't leak one entry per session
// forever. Oldest-pinned entries are evicted first; entries older than the TTL
// are lazily dropped on read.

function maxSessions(): number {
  const raw = Number(process.env['SUDO_CACHE_AFFINITY_MAX_SESSIONS']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
}

function ttlMs(): number {
  const raw = Number(process.env['SUDO_CACHE_AFFINITY_TTL_MS']);
  // Default 24h: a conversation that's been idle a full day no longer benefits
  // from a warm provider cache anyway (the provider will have evicted it).
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24 * 60 * 60 * 1000;
}

// Insertion-ordered Map ⇒ the first key is the oldest inserted. We re-insert on
// update so recency order tracks pinnedAt for the eviction sweep.
const store = new Map<string, SessionAffinity>();

/** Derive the provider prefix from a provider-qualified model string. */
function providerOf(model: string): string {
  const slash = model.indexOf('/');
  return slash >= 0 ? model.slice(0, slash) : model;
}

/**
 * Read a session's pin, or null if none / expired. Expired entries are dropped
 * lazily. `now` is injectable for deterministic tests.
 */
export function getSessionAffinity(sessionId: string, now: number = Date.now()): SessionAffinity | null {
  if (!sessionId) return null;
  const pin = store.get(sessionId);
  if (!pin) return null;
  if (now - pin.pinnedAt > ttlMs()) {
    store.delete(sessionId);
    return null;
  }
  return pin;
}

/**
 * Pin a session to a provider-qualified model. First writer wins by default:
 * an existing (non-expired) pin is NOT overwritten unless `force` is set — this
 * is what keeps a transient hard-fail failover from repinning the session
 * (spec §3). Returns the effective pin.
 *
 * `now` is injectable for deterministic tests.
 */
export function setSessionAffinity(
  sessionId: string,
  model: string,
  opts: { force?: boolean; now?: number } = {},
): SessionAffinity | null {
  if (!sessionId || !model) return null;
  const now = opts.now ?? Date.now();

  if (!opts.force) {
    const existing = getSessionAffinity(sessionId, now);
    if (existing) return existing;
  }

  const pin: SessionAffinity = { sessionId, model, provider: providerOf(model), pinnedAt: now };
  // Re-insert so Map iteration order reflects recency (delete-then-set moves it
  // to the tail).
  store.delete(sessionId);
  store.set(sessionId, pin);
  evict(now);
  return pin;
}

/** Remove a session's pin (e.g. `/cache off`). No-op if absent. */
export function clearSessionAffinity(sessionId: string): void {
  store.delete(sessionId);
}

/**
 * Bound the store: drop expired entries, then evict oldest-inserted until at or
 * under the cap. Called after every insert.
 */
function evict(now: number): void {
  const ttl = ttlMs();
  for (const [id, pin] of store) {
    if (now - pin.pinnedAt > ttl) store.delete(id);
  }
  const cap = maxSessions();
  while (store.size > cap) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// --- Test-only helpers ------------------------------------------------------

/** Current number of pinned sessions (test/telemetry). */
export function affinityStoreSize(): number {
  return store.size;
}

/** Wipe the store — tests only. */
export function _resetAffinityStoreForTest(): void {
  store.clear();
}
