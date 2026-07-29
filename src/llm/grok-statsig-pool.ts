/**
 * @file grok-statsig-pool.ts
 * @description API-level statsig-token supply for the free grok.com app-chat
 * lane. x-statsig-id is SINGLE-USE (consumed per successful turn), so an
 * agentic brain needs a fresh token every call. Minting one on the hot path is
 * the bottleneck: the warm-browser oracle costs a one-time ~15s warm-up, then
 * ~0.5–1s per in-page `__grokMint` — fine, but serial and occasionally flaky.
 *
 * This pool decouples SERVING from MINTING: it buffers a small set of
 * pre-minted, validated tokens and hands them out instantly, while a
 * single-flight background refiller keeps the buffer topped up ahead of demand.
 * Under concurrency each `acquire()` shifts a DISTINCT token (JS is
 * single-threaded, so the shift never races), and an empty buffer falls back to
 * an on-demand validated mint so a burst never hard-fails — it just degrades to
 * the un-pooled latency for that one call.
 *
 * WHY oracle-only (not pure-Node from a seed): the browserless seed-mint
 * produces correctly-shaped 94-char tokens the server REJECTS (403) — the
 * server-side fingerprint needs the real in-page minter, verified live. So the
 * pool's `mint` is always the oracle; the win is pre-minting, not a cheaper mint.
 *
 * Freshness: tokens encode a per-second timestamp; the server accepts a recent
 * window. The pool evicts tokens older than `maxAgeMs` so a stale buffered token
 * is never served.
 */

import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-statsig-pool');

/** The only statsig-gated endpoint (chat + video). */
const APP_CHAT_NEW = '/rest/app-chat/conversations/new';
const MIN_STATSIG_LEN = 80;

/** A raw mint (oracle-backed in prod, injected in tests). */
export type StatsigMintFn = (reqPath: string, method: string) => Promise<string>;

export interface GrokStatsigPoolOptions {
  /** Underlying token source (oracle in prod). */
  mint: StatsigMintFn;
  /** Desired buffered-token count kept ahead of demand. Default 4. */
  target?: number;
  /** Evict buffered tokens older than this (ms). Default 45_000. */
  maxAgeMs?: number;
  /** Retries when a mint throws/returns a short token. Default 4. */
  mintAttempts?: number;
  /** Request path the tokens are minted for. Default app-chat conversations/new. */
  reqPath?: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface Buffered {
  token: string;
  born: number;
}

export class GrokStatsigPool {
  private readonly mintFn: StatsigMintFn;
  private readonly target: number;
  private readonly maxAgeMs: number;
  private readonly mintAttempts: number;
  private readonly reqPath: string;
  private readonly now: () => number;
  private buf: Buffered[] = [];
  private refilling: Promise<void> | null = null;

  public constructor(opts: GrokStatsigPoolOptions) {
    this.mintFn = opts.mint;
    this.target = Math.max(1, opts.target ?? 4);
    this.maxAgeMs = opts.maxAgeMs ?? 45_000;
    this.mintAttempts = opts.mintAttempts ?? 4;
    this.reqPath = opts.reqPath ?? APP_CHAT_NEW;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Live (non-stale) buffered token count. */
  public size(): number {
    this.evictStale();
    return this.buf.length;
  }

  /**
   * Return a fresh single-use token. Serves instantly from the buffer when
   * available; otherwise mints one on demand. Always kicks a background refill.
   */
  public async acquire(): Promise<string> {
    this.evictStale();
    const item = this.buf.shift();
    // Fire-and-forget top-up; never block acquire on it.
    void this.refill();
    if (item) return item.token;
    // Buffer empty (cold start or burst) → don't fail, mint one now.
    return this.mintValidated();
  }

  /** Pre-warm the buffer (e.g. at brain start) so the first turn is instant. */
  public async prime(): Promise<void> {
    await this.refill();
  }

  private evictStale(): void {
    const cutoff = this.now() - this.maxAgeMs;
    if (this.buf.length && this.buf[0]!.born < cutoff) {
      const before = this.buf.length;
      this.buf = this.buf.filter((b) => b.born >= cutoff);
      log.debug({ evicted: before - this.buf.length }, 'evicted stale statsig tokens');
    }
  }

  /** Single-flight background refill up to target. */
  private refill(): Promise<void> {
    if (this.refilling) return this.refilling;
    this.refilling = (async () => {
      try {
        while (this.size() < this.target) {
          const token = await this.mintValidated();
          this.buf.push({ token, born: this.now() });
        }
      } catch (err) {
        // A failed refill is non-fatal — acquire() falls back to on-demand mint.
        log.warn({ detail: (err as Error).message }, 'statsig pool refill failed (will retry on next acquire)');
      } finally {
        this.refilling = null;
      }
    })();
    return this.refilling;
  }

  /** Mint one token, retrying past the oracle's intermittent empty/short yields. */
  private async mintValidated(): Promise<string> {
    let lastLen = 0;
    for (let i = 0; i < this.mintAttempts; i++) {
      try {
        const tok = await this.mintFn(this.reqPath, 'POST');
        if (tok && tok.length >= MIN_STATSIG_LEN) return tok;
        lastLen = tok ? tok.length : 0;
        log.warn({ attempt: i + 1, len: lastLen }, 'statsig mint returned short/empty — retrying');
      } catch (err) {
        log.warn({ attempt: i + 1, detail: (err as Error).message }, 'statsig mint threw — retrying');
      }
    }
    throw new Error(`statsig mint failed after ${this.mintAttempts} attempts (last len ${lastLen})`);
  }
}

// ---------------------------------------------------------------------------
// Process singleton wired to the warm-browser oracle (the real prod source).
// ---------------------------------------------------------------------------

let singleton: GrokStatsigPool | null = null;

/**
 * Browserless self-heal: on algorithm drift the pure-Node minter yields
 * length-valid tokens the gate REJECTS (403) — the pool can't detect that from
 * the token alone. `chatGrokWeb` calls demoteGrokBrowserlessStatsig() on a
 * persistent anti-bot 403 so subsequent mints skip browserless and use the
 * oracle (browser-backed, always current) for a cooldown — the lane keeps
 * working (degraded) instead of failing over, and the drift canary alerts.
 */
let browserlessDemotedUntil = 0;
const DEFAULT_DEMOTE_MS = 30 * 60_000;

/** Skip the pure-Node minter and use the oracle for `cooldownMs` (default 30m). */
export function demoteGrokBrowserlessStatsig(cooldownMs = DEFAULT_DEMOTE_MS): void {
  browserlessDemotedUntil = Date.now() + cooldownMs;
  log.warn({ cooldownMs }, 'browserless statsig demoted — using oracle until cooldown (suspected algorithm drift)');
}

/** True when pure-Node (browserless) minting is currently allowed (flag on + not demoted). */
export function isGrokBrowserlessActive(now: number = Date.now()): boolean {
  return process.env['SUDO_GROK_STATSIG_BROWSERLESS'] === '1' && now >= browserlessDemotedUntil;
}

/** Test hook — clear any active demotion. */
export function __resetGrokBrowserlessDemotion(): void {
  browserlessDemotedUntil = 0;
}

/**
 * The shared app-chat statsig pool. When SUDO_GROK_STATSIG_BROWSERLESS=1 it mints
 * PURE-NODE (curl the page seed → `mintStatsigFromSeed`, no browser — the
 * reverse-engineered algorithm, live-gate-proven) and only falls back to the
 * warm-browser oracle if the browserless mint fails. Default (flag off): oracle.
 */
export function getGrokStatsigPool(): GrokStatsigPool {
  if (singleton) return singleton;
  const oracleMint = async (reqPath: string, method: string): Promise<string> => {
    const { getGrokStatsigOracle } = await import('./grok-statsig-oracle.js');
    return getGrokStatsigOracle({
      cdpUrl: process.env['SUDO_GROK_ORACLE_CDP_URL'] ?? undefined,
    }).mint(reqPath, method);
  };
  const mint: StatsigMintFn = async (reqPath, method) => {
    if (isGrokBrowserlessActive()) {
      try {
        const [{ getGrokWebSessionManager }, { callGrokWebBridge }, { mintStatsigFromSeed }] =
          await Promise.all([
            import('./grok-web-session-manager.js'),
            import('./grok-web-bridge.js'),
            import('./grok-statsig-mint.js'),
          ]);
        const session = await getGrokWebSessionManager().ensureHealthy();
        const seedRes = await callGrokWebBridge(
          { op: 'seed' },
          { cookie: session.cookie, userAgent: session.userAgent },
        );
        if (seedRes.ok && seedRes.seed) {
          const tok = mintStatsigFromSeed(seedRes.seed, reqPath, method, Date.now());
          if (tok && tok.length >= MIN_STATSIG_LEN) return tok;
        }
        log.warn('browserless statsig mint returned no valid token — falling back to oracle');
      } catch (err) {
        log.warn({ detail: (err as Error).message }, 'browserless statsig mint failed — falling back to oracle');
      }
    }
    return oracleMint(reqPath, method);
  };
  singleton = new GrokStatsigPool({
    mint,
    target: Number(process.env['SUDO_GROK_STATSIG_POOL'] ?? '4') || 4,
  });
  return singleton;
}

/** Test hook — drop the singleton. */
export function __resetGrokStatsigPool(): void {
  singleton = null;
}
