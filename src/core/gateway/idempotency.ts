/**
 * gateway/idempotency.ts — GW-8
 *
 * A bounded, TTL'd idempotency store for side-effecting WS/RPC methods. A
 * mutating call carries an `idempotencyKey`; the first call for a key runs the
 * handler and the result promise is cached, so a duplicate key within the TTL
 * returns the SAME settled outcome and NEVER re-executes (this is the shape of
 * the session fork loop, #445-#447).
 *
 * The stored value is the in-flight promise itself, so concurrent duplicates
 * (a retry that arrives before the first completes) also collapse to a single
 * execution. A rejected outcome is cached too: a replay within TTL reproduces
 * the identical error rather than re-running the side effect.
 *
 * OpenClaw dedupe numbers: 5-minute TTL, 1000 entries.
 */

/** OpenClaw dedupe defaults. */
export const IDEMPOTENCY_TTL_MS = 5 * 60_000;
export const IDEMPOTENCY_MAX_ENTRIES = 1000;

interface Entry {
  promise: Promise<unknown>;
  /** Epoch ms at which this entry expires. */
  expiresAt: number;
}

export interface IdempotencyOptions {
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * In-memory idempotency cache. Not shared across processes — WS/RPC is a
 * single-daemon surface, so a per-process map is the source of truth.
 */
export class IdempotencyStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Insertion-ordered map → O(1) oldest eviction via the first key. */
  private readonly entries = new Map<string, Entry>();

  constructor(opts: IdempotencyOptions = {}, now: () => number = Date.now) {
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.maxEntries = opts.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES;
    this.now = now;
  }

  /**
   * Run `factory` at most once per `key` within the TTL. Returns `{ promise,
   * replayed }` — `replayed` is true when a cached result was returned instead
   * of invoking `factory`.
   */
  run<T>(key: string, factory: () => Promise<T>): { promise: Promise<T>; replayed: boolean } {
    const t = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > t) {
      return { promise: existing.promise as Promise<T>, replayed: true };
    }
    if (existing) this.entries.delete(key); // expired — fall through to re-run

    const promise = factory();
    this.entries.set(key, { promise, expiresAt: t + this.ttlMs });
    this.pruneExpired(t);
    this.evictOverflow();
    return { promise, replayed: false };
  }

  /** Number of live (unexpired) entries — test/introspection helper. */
  size(): number {
    this.pruneExpired(this.now());
    return this.entries.size;
  }

  private pruneExpired(t: number): void {
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= t) this.entries.delete(k);
      else break; // insertion-ordered: first live entry ⇒ rest are live-ish
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
