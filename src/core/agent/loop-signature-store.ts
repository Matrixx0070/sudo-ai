/**
 * @file loop-signature-store.ts
 * @description Persistent ledger of loop signatures so LoopGuard learns
 *              across sessions instead of re-discovering the same loop.
 *
 * Problem this solves (bot's architectural audit, fix #5):
 *   "No real loop-cost circuit breaker. LoopGuard reacts at 5 iterations but
 *   doesn't learn. Same loop recurs across sessions. Fix: persist loop
 *   signatures; if a signature recurs across sessions, auto-suppress the
 *   trigger instead of re-fighting it."
 *
 * Approach:
 *   When LoopGuard aborts a turn, it records the signature (toolName + args
 *   hash, or the ping-pong pair) here. On subsequent turns, before reaching
 *   the normal warn/abort thresholds (10/20), LoopGuard checks the store —
 *   if the signature has hit the persistence threshold across sessions, the
 *   guard tightens immediately (abort at the first identical call instead
 *   of the tenth) so the agent never has to burn iterations rediscovering
 *   the same loop.
 *
 * Scope:
 *   Plain SQLite table created on first use. Pure CRUD; no LoopGuard
 *   business logic lives here. The wiring side decides what counts as
 *   "fast-suppress" — this module just persists hits and exposes them.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:loop-signature-store');

/**
 * Once a signature has hit at least this many distinct sessions, treat it
 * as "known bad" and short-circuit the LoopGuard thresholds. Two is the
 * minimum non-noise — once is just one session's bad luck.
 */
export const DEFAULT_SUPPRESS_HITS = 2;

/** Default eviction age. Older entries auto-prune. */
export const DEFAULT_MAX_AGE_DAYS = 30;

export interface SignatureRow {
  signature: string;
  hits: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Persistent signature store backed by SQLite. Schema is created on demand
 * via CREATE TABLE IF NOT EXISTS — safe to instantiate multiple times.
 */
export class LoopSignatureStore {
  constructor(private readonly db: Database.Database) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_signatures (
        signature   TEXT    PRIMARY KEY,
        hits        INTEGER NOT NULL DEFAULT 1,
        first_seen  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_loop_signatures_last_seen
        ON loop_signatures(last_seen)
    `);
  }

  /**
   * Insert a fresh signature or increment the hit count on an existing one.
   * Returns the post-write hits value so callers can decide whether the
   * signature is now over the suppress threshold.
   */
  record(signature: string): number {
    if (!signature) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO loop_signatures (signature, hits, first_seen, last_seen)
      VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(signature) DO UPDATE SET
        hits = hits + 1,
        last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `);
    stmt.run(signature);
    const row = this.db
      .prepare<{ s: string }, { hits: number }>("SELECT hits FROM loop_signatures WHERE signature = :s")
      .get({ s: signature });
    return row?.hits ?? 0;
  }

  /** Return current hits for a signature (0 if unknown). */
  getHits(signature: string): number {
    if (!signature) return 0;
    const row = this.db
      .prepare<{ s: string }, { hits: number }>("SELECT hits FROM loop_signatures WHERE signature = :s")
      .get({ s: signature });
    return row?.hits ?? 0;
  }

  /**
   * Whether a signature should be fast-suppressed — i.e. has been hit in at
   * least `suppressHits` distinct prior aborts.
   */
  shouldSuppress(signature: string, suppressHits: number = DEFAULT_SUPPRESS_HITS): boolean {
    return this.getHits(signature) >= suppressHits;
  }

  /** Diagnostic — total stored signatures. */
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM loop_signatures").get() as { c: number }).c;
  }

  /**
   * Drop signatures last seen more than `maxAgeDays` ago. Old loops that
   * stopped happening should fade naturally — this prevents the store
   * growing without bound and lets the guard relax if upstream code
   * fixed the trigger.
   */
  prune(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): number {
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const info = this.db
      .prepare<{ c: string }>("DELETE FROM loop_signatures WHERE last_seen < :c")
      .run({ c: cutoffIso });
    if (info.changes > 0) {
      log.info({ pruned: info.changes, cutoffIso }, 'LoopSignatureStore pruned');
    }
    return info.changes;
  }
}

// ---------------------------------------------------------------------------
// Signature helpers
//
// LoopGuard recognises two abort triggers: identical repeat (one tool +
// argsHash) and ping-pong (two distinct tool+argsHash pairs cycling). We
// canonicalise both into a single signature space so the persistence layer
// doesn't need to know which detector fired.
// ---------------------------------------------------------------------------

/** Signature for a "same tool, same args, called too many times" abort. */
export function repeatSignature(toolName: string, argsHash: string): string {
  return `repeat:${toolName}#${argsHash}`;
}

/** Signature for an A/B ping-pong abort. Stable regardless of order. */
export function pingPongSignature(
  aTool: string, aArgsHash: string,
  bTool: string, bArgsHash: string,
): string {
  const left = `${aTool}#${aArgsHash}`;
  const right = `${bTool}#${bArgsHash}`;
  const [first, second] = left <= right ? [left, right] : [right, left];
  return `pingpong:${first}|${second}`;
}

// ---------------------------------------------------------------------------
// Module-level singleton — set once at boot, read lazily by LoopGuard.
//
// LoopGuard is field-initialised inside AgentLoop with no args, so a
// constructor-injected store would ripple through every instantiation. The
// setter lets cli.ts wire it once (after MindDB is up) without touching any
// LoopGuard call site. When unset, LoopGuard keeps its old behaviour.
// ---------------------------------------------------------------------------

let globalSignatureStore: LoopSignatureStore | null = null;

export function setGlobalLoopSignatureStore(store: LoopSignatureStore | null): void {
  globalSignatureStore = store;
}

export function getGlobalLoopSignatureStore(): LoopSignatureStore | null {
  return globalSignatureStore;
}

/** Test helper — clears the global without affecting any underlying DB. */
export function __resetGlobalLoopSignatureStoreForTests(): void {
  globalSignatureStore = null;
}
