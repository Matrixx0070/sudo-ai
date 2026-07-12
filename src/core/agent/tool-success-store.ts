/**
 * @file tool-success-store.ts
 * @description Per-tool outcome memory that GATES tool selection — the piece
 *              that turns recorded outcomes into a decision-time signal instead
 *              of a write-only diary (gap #1, "real learning from outcomes").
 *
 * Problem this solves:
 *   ToolOutcomeLearner records every tool result into logging sinks, but nothing
 *   read those stats back to change which tools the model sees. The ToolRouter
 *   is a static keyword ranker. So a tool that keeps failing in practice kept
 *   getting offered at the same rank as a reliable sibling.
 *
 * Approach (bandit-lite, exploit-with-exploration):
 *   Track a recency-weighted success rate (EMA) per tool, persisted to mind.db
 *   so learning compounds across restarts/sessions. At route time the router
 *   asks bias(tool) for a bounded additive term folded into the within-category
 *   relevance sort: chronically-failing tools sink (and fall past the routed-tool
 *   cap), reliable ones surface. Two guards keep it from over-fitting:
 *     - MIN_SAMPLES: no bias until we've seen enough calls (pure exploration
 *       while cold — never bury a tool on one bad turn).
 *     - bounded bias range: never large enough to override a strong keyword
 *       match, so a tool the user explicitly describes still routes even if its
 *       recent record is poor (recovery path preserved).
 *
 * Scope: pure CRUD + an in-memory cache for synchronous reads on the hot path.
 * The router decides how to fold bias in; this module only measures.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:tool-success-store');

/** EMA weight for the newest outcome. Higher = faster to react, noisier. */
export const DEFAULT_ALPHA = 0.25;
/** No bias emitted until a tool has at least this many recorded calls. */
export const DEFAULT_MIN_SAMPLES = 5;
/** Success rate treated as "neutral" (most tools succeed most of the time). */
export const DEFAULT_BASELINE = 0.7;
/** Scale factor mapping (ema - baseline) into bias units. */
export const DEFAULT_SCALE = 2;
/** Bias clamp — asymmetric: punish failure hard, reward success mildly. */
export const DEFAULT_MIN_BIAS = -2;
export const DEFAULT_MAX_BIAS = 1;

export interface ToolStat {
  tool: string;
  n: number;
  ema: number;
}

interface CacheEntry { n: number; ema: number; dirty: boolean }

export interface ToolSuccessStoreOptions {
  alpha?: number;
  minSamples?: number;
  baseline?: number;
  scale?: number;
  minBias?: number;
  maxBias?: number;
}

/**
 * Persistent per-tool success-rate store backed by SQLite, cached in memory for
 * O(1) synchronous bias() reads on the routing hot path. Schema is created on
 * demand — safe to instantiate multiple times against the same db.
 */
export class ToolSuccessStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly alpha: number;
  private readonly minSamples: number;
  private readonly baseline: number;
  private readonly scale: number;
  private readonly minBias: number;
  private readonly maxBias: number;

  constructor(private readonly db: Database.Database, opts: ToolSuccessStoreOptions = {}) {
    this.alpha = opts.alpha ?? DEFAULT_ALPHA;
    this.minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.baseline = opts.baseline ?? DEFAULT_BASELINE;
    this.scale = opts.scale ?? DEFAULT_SCALE;
    this.minBias = opts.minBias ?? DEFAULT_MIN_BIAS;
    this.maxBias = opts.maxBias ?? DEFAULT_MAX_BIAS;
    this.initSchema();
    this.load();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_outcome_stats (
        tool        TEXT    PRIMARY KEY,
        n           INTEGER NOT NULL DEFAULT 0,
        ema         REAL    NOT NULL DEFAULT 1.0,
        first_seen  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
  }

  /** Warm the in-memory cache from disk so bias() is meaningful immediately. */
  private load(): void {
    try {
      const rows = this.db.prepare('SELECT tool, n, ema FROM tool_outcome_stats').all() as ToolStat[];
      for (const r of rows) this.cache.set(r.tool, { n: r.n, ema: r.ema, dirty: false });
      log.info({ tools: rows.length }, 'ToolSuccessStore warmed from disk');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ToolSuccessStore load failed — starting cold');
    }
  }

  /**
   * Record one tool outcome. Updates the recency-weighted success rate in
   * memory and marks the row dirty for the next flush. Cheap (no DB write).
   */
  record(tool: string, success: boolean): void {
    if (!tool) return;
    const prev = this.cache.get(tool);
    const reward = success ? 1 : 0;
    if (!prev) {
      // Seed ema at the first observed reward so a brand-new failing tool isn't
      // masked by the optimistic 1.0 default until it clears MIN_SAMPLES.
      this.cache.set(tool, { n: 1, ema: reward, dirty: true });
    } else {
      prev.ema = this.alpha * reward + (1 - this.alpha) * prev.ema;
      prev.n += 1;
      prev.dirty = true;
    }
  }

  /**
   * Bounded additive bias for the router's within-category sort. 0 while the
   * tool is under MIN_SAMPLES (explore); otherwise negative for chronic
   * failers, mildly positive for reliable tools, clamped.
   */
  bias(tool: string): number {
    const e = this.cache.get(tool);
    if (!e || e.n < this.minSamples) return 0;
    const raw = ((e.ema - this.baseline) / this.baseline) * this.scale;
    return Math.max(this.minBias, Math.min(this.maxBias, raw));
  }

  /** Current recency-weighted success rate (or null if unknown). Diagnostic. */
  successRate(tool: string): number | null {
    return this.cache.get(tool)?.ema ?? null;
  }

  /** Persist dirty rows. Call periodically and on shutdown. */
  flush(): number {
    let written = 0;
    const stmt = this.db.prepare(`
      INSERT INTO tool_outcome_stats (tool, n, ema, first_seen, last_seen)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(tool) DO UPDATE SET
        n = excluded.n, ema = excluded.ema, last_seen = excluded.last_seen
    `);
    const tx = this.db.transaction((entries: Array<[string, CacheEntry]>) => {
      for (const [tool, e] of entries) {
        if (!e.dirty) continue;
        stmt.run(tool, e.n, e.ema);
        e.dirty = false;
        written++;
      }
    });
    try {
      tx([...this.cache.entries()]);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ToolSuccessStore flush failed');
    }
    return written;
  }

  /** Diagnostic snapshot of all tracked tools (sorted worst-first). */
  snapshot(): ToolStat[] {
    return [...this.cache.entries()]
      .map(([tool, e]) => ({ tool, n: e.n, ema: e.ema }))
      .sort((a, b) => a.ema - b.ema);
  }

  /** Total tracked tools. */
  count(): number {
    return this.cache.size;
  }
}
