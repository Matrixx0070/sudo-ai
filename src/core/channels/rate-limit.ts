/**
 * @file rate-limit.ts
 * @description Per-peer token-bucket rate limiter for channel adapters.
 *
 * Features:
 *  - Token bucket per (channel, peerId) pair.
 *  - Configurable via SUDO_RATE_LIMIT_* env vars; per-channel overrides supported.
 *  - In-memory Map with hard cap (50 000 buckets); LRU eviction of oldest 10 000 on overflow.
 *  - Periodic GC: prune buckets with lastAccess > 1 hour every 60 s.
 *  - burstWarned deduplication: only the first denial per block-window triggers a warning.
 *  - Optional persistence to workspace/rate-limits.json every 60 s (SUDO_RATE_LIMIT_PERSIST=1).
 *  - Hook emission: rate-limit:triggered fires once per block-window transition.
 */

import { writeFile, rename, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/index.js';
import { WORKSPACE_DIR } from '../shared/paths.js';
import type { HookContext, HookEvent } from '../hooks/index.js';

const log = createLogger('channels:rate-limit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUCKETS = 50_000;
const EVICT_COUNT = 10_000;
const GC_INTERVAL_MS = 60_000;
const BUCKET_TTL_MS = 3_600_000; // 1 hour
const PERSIST_INTERVAL_MS = 60_000;
const REFILL_WINDOW_MS = 60_000; // tokens refill over 1 minute
const PERSIST_FILE = join(WORKSPACE_DIR, 'rate-limits.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Tokens refilled per minute (default: SUDO_RATE_LIMIT_PER_MIN env or 20) */
  perMinute: number;
  /** Burst allowance above refill rate (default: SUDO_RATE_LIMIT_BURST env or 5) */
  burst: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** Only present when !allowed */
  retryAfterMs?: number;
  /** Tokens remaining after this check (0 when denied) */
  remaining: number;
  /**
   * When false: this is the FIRST denial in this block-window — caller should
   * send the "please slow down" warning.
   * When true: already warned — stay silent.
   */
  burstWarned: boolean;
}

export interface RateLimiter {
  check(channel: string, peerId: string): Promise<RateLimitCheckResult>;
  reset(channel: string, peerId: string): void;
  setHookEmitter(emitter: HookEmitterLike): void;
  shutdown(): Promise<void>;
}

/** Minimal hook-emission interface compatible with HookManager. */
export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
  burstWarned: boolean;
}

type PersistedBuckets = Record<string, TokenBucket>;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve rate-limit config for a given channel.
 * Per-channel env vars (e.g. SUDO_RATE_LIMIT_TELEGRAM_PER_MIN) take precedence
 * over global vars (SUDO_RATE_LIMIT_PER_MIN), which fall back to defaults.
 */
function resolveConfig(channel: string): RateLimitConfig {
  const chan = channel.toUpperCase();
  const perMinuteStr =
    process.env[`SUDO_RATE_LIMIT_${chan}_PER_MIN`] ??
    process.env['SUDO_RATE_LIMIT_PER_MIN'];
  const burstStr =
    process.env[`SUDO_RATE_LIMIT_${chan}_BURST`] ??
    process.env['SUDO_RATE_LIMIT_BURST'];

  const parsedPerMin = perMinuteStr ? parseInt(perMinuteStr, 10) : NaN;
  const perMinute = Number.isNaN(parsedPerMin) ? 20 : Math.max(1, parsedPerMin);
  const parsedBurst = burstStr ? parseInt(burstStr, 10) : NaN;
  // Burst ceiling of 1000 — prevents SUDO_RATE_LIMIT_BURST=999999999 from
  // effectively disabling the limiter by granting unlimited burst tokens.
  const burst = Number.isNaN(parsedBurst) ? 5 : Math.min(Math.max(0, parsedBurst), 1000);

  return { perMinute, burst };
}

// ---------------------------------------------------------------------------
// Bucket key helpers
// ---------------------------------------------------------------------------

/**
 * Encode peerId so that any character sequence (including `::`) maps to a
 * unique, safe string.  `encodeURIComponent` is idempotent on already-encoded
 * strings and guarantees uniqueness — no two distinct peerIds can produce the
 * same encoded form.  This fixes the `"a::b"` ↔ `"a__b"` collision that the
 * previous `::` → `__` replacement introduced.
 */
function sanitizePeerId(peerId: string): string {
  return encodeURIComponent(peerId);
}

function bucketKey(channel: string, peerId: string): string {
  return `${channel}::${sanitizePeerId(peerId)}`;
}

// ---------------------------------------------------------------------------
// Rate limiter implementation
// ---------------------------------------------------------------------------

class RateLimiterImpl implements RateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();
  /**
   * Insertion-ordered LRU tracker.  ES Maps iterate in insertion order.
   * On each access: delete(key) then set(key, 1) moves the key to the end.
   * On eviction: take the first EVICT_COUNT keys (= oldest accessed).
   * This gives O(1) per-access cost and O(k) eviction — far cheaper than the
   * previous O(n log n) Array.sort over 50K entries.
   */
  private readonly accessOrder: Map<string, 1> = new Map();
  private _hookEmitter: HookEmitterLike | null = null;
  private _gcTimer: ReturnType<typeof setInterval> | null = null;
  private _persistTimer: ReturnType<typeof setInterval> | null = null;
  private _flushing: Promise<void> | null = null;
  private readonly _persist: boolean;

  constructor() {
    this._persist = process.env['SUDO_RATE_LIMIT_PERSIST'] === '1';

    // Start GC interval (unref so it doesn't block process exit).
    this._gcTimer = setInterval(() => this._gc(), GC_INTERVAL_MS);
    if (this._gcTimer.unref) this._gcTimer.unref();

    // Optionally start persistence interval.
    if (this._persist) {
      void this._loadPersisted();
      this._persistTimer = setInterval(() => { void this._flushPersisted(); }, PERSIST_INTERVAL_MS);
      if (this._persistTimer.unref) this._persistTimer.unref();
    }
  }

  setHookEmitter(emitter: HookEmitterLike): void {
    this._hookEmitter = emitter;
  }

  async check(channel: string, peerId: string): Promise<RateLimitCheckResult> {
    const key = bucketKey(channel, peerId);
    const config = resolveConfig(channel);
    const maxTokens = config.perMinute + config.burst;
    const now = Date.now();

    // Get or create bucket.
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: maxTokens,
        lastRefill: now,
        lastAccess: now,
        burstWarned: false,
      };
      this.buckets.set(key, bucket);
    }

    // Move to end of LRU access-order map (delete + re-set preserves insertion order).
    this.accessOrder.delete(key);
    this.accessOrder.set(key, 1);

    // Refill tokens based on elapsed time. Clamp elapsed to 0 to guard against clock skew.
    const elapsed = Math.max(0, now - bucket.lastRefill);
    const tokensToAdd = (elapsed / REFILL_WINDOW_MS) * config.perMinute;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    bucket.lastAccess = now;

    // Reset burstWarned only when the bucket is meaningfully recovered (near-full),
    // not on every small refill tick — prevents spammy repeated warnings during
    // sustained over-rate bursts.
    if (bucket.tokens >= maxTokens - 0.5) {
      bucket.burstWarned = false;
    }

    // Enforce cap AFTER updates — we want existing peer to get checked, not evicted mid-call.
    this._enforceCapIfNeeded();

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), burstWarned: false };
    }

    // Denied — calculate retryAfterMs.
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded / config.perMinute) * REFILL_WINDOW_MS);

    // burstWarned deduplication: only emit hook + return burstWarned=false on FIRST denial.
    const wasAlreadyWarned = bucket.burstWarned;
    if (!wasAlreadyWarned) {
      bucket.burstWarned = true;
      void this._emitHook(channel, peerId, retryAfterMs);
    }

    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      burstWarned: wasAlreadyWarned,
    };
  }

  reset(channel: string, peerId: string): void {
    const key = bucketKey(channel, peerId);
    this.buckets.delete(key);
    this.accessOrder.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Private: GC
  // ---------------------------------------------------------------------------

  private _gc(): void {
    const cutoff = Date.now() - BUCKET_TTL_MS;
    let pruned = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess < cutoff) {
        this.buckets.delete(key);
        this.accessOrder.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      log.debug({ pruned, remaining: this.buckets.size }, 'Rate-limit GC pruned stale buckets');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: cap enforcement (LRU eviction)
  // ---------------------------------------------------------------------------

  private _enforceCapIfNeeded(): void {
    if (this.buckets.size <= MAX_BUCKETS) return;

    // O(k) LRU eviction using insertion-ordered accessOrder Map.
    // The Map iterates in insertion order; because we delete+re-set on every
    // access (in check()), keys at the front are the least-recently-used.
    // We collect the first EVICT_COUNT keys and delete from both maps.
    let evicted = 0;
    for (const key of this.accessOrder.keys()) {
      if (evicted >= EVICT_COUNT) break;
      this.buckets.delete(key);
      this.accessOrder.delete(key);
      evicted++;
    }

    log.warn(
      { evicted, remaining: this.buckets.size },
      'Rate-limit bucket cap exceeded — evicted oldest entries',
    );
  }

  // ---------------------------------------------------------------------------
  // Private: hook emission
  // ---------------------------------------------------------------------------

  private async _emitHook(channel: string, peerId: string, retryAfterMs: number): Promise<void> {
    if (!this._hookEmitter) return;
    try {
      await this._hookEmitter.emit('rate-limit:triggered', {
        event: 'rate-limit:triggered',
        channel: channel as import('../hooks/index.js').HookContext['channel'],
        peerId,
        meta: { retryAfterMs },
      } as HookContext);
    } catch (err) {
      log.warn({ channel, peerId, err: String(err) }, 'rate-limit hook emission failed — continuing');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: persistence
  // ---------------------------------------------------------------------------

  private async _loadPersisted(): Promise<void> {
    if (!existsSync(PERSIST_FILE)) return;
    try {
      const raw = await readFile(PERSIST_FILE, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log.warn('rate-limits.json is malformed — skipping load');
        return;
      }
      const now = Date.now();
      let loaded = 0;
      let skipped = 0;
      for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!this._isValidBucket(entry)) {
          log.warn({ key }, 'Skipping malformed rate-limit bucket entry');
          skipped++;
          continue;
        }
        // Only restore buckets that were active within the last hour.
        if (now - entry.lastRefill > BUCKET_TTL_MS) {
          skipped++;
          continue;
        }
        this.buckets.set(key, { ...entry });
        this.accessOrder.set(key, 1);
        loaded++;
      }
      log.info({ loaded, skipped }, 'Rate-limit buckets restored from persistence');
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to load persisted rate limits — starting fresh');
    }
  }

  async shutdown(): Promise<void> {
    if (this._gcTimer) { clearInterval(this._gcTimer); this._gcTimer = null; }
    if (this._persistTimer) { clearInterval(this._persistTimer); this._persistTimer = null; }
    if (this._persist) await this._flushPersisted();
  }

  private async _flushPersisted(): Promise<void> {
    // Coalesce concurrent flushes: if one is already in flight, wait for it
    // instead of racing two rename() calls against each other.
    if (this._flushing) return this._flushing;
    this._flushing = this._doFlush().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  private async _doFlush(): Promise<void> {
    const data: PersistedBuckets = {};
    for (const [key, bucket] of this.buckets) {
      data[key] = { ...bucket };
    }

    const tmpFile = join(WORKSPACE_DIR, `rate-limits.${randomUUID()}.tmp.json`);
    try {
      await mkdir(WORKSPACE_DIR, { recursive: true });
      await writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      await rename(tmpFile, PERSIST_FILE);
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to persist rate limits');
      // Best-effort cleanup of tmp file. Unlink rather than rename to a
      // .failed variant, since each tmpFile has a unique UUID and renaming on
      // every recurring failure would leak unbounded orphan files in WORKSPACE_DIR.
      try { await unlink(tmpFile); } catch { /* ignore */ }
    }
  }

  private _isValidBucket(entry: unknown): entry is TokenBucket {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const b = entry as Record<string, unknown>;
    return (
      typeof b['tokens'] === 'number' &&
      typeof b['lastRefill'] === 'number' &&
      typeof b['lastAccess'] === 'number' &&
      typeof b['burstWarned'] === 'boolean'
    );
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const rateLimiter: RateLimiter = new RateLimiterImpl();
