/**
 * policy-decision-log.ts — AL6.2/AL6.5 durable decision log.
 *
 * Persists every PolicyResolver decision (with its input signals) into
 * `policy_decisions` beside `llm_calls` in gateway.db, so the AL6.5
 * shadow-vs-live comparison query can join the two on turn_id and answer
 * "would the shadow policy have degraded success/latency?" before any
 * policy is promoted to live.
 *
 * Column names match the comparison query in docs/AGENTIC_LADDER_STATUS.md:
 * at / intent / route_hint / shadow (+ turn_id / session_id when the caller
 * supplies them). Writes are fire-and-forget: a broken log must never break
 * the routing hot path.
 */

import { mkdirSync } from 'fs';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import type { PolicyDecisionEntry } from './policy-resolver.js';

const log = createLogger('agent:policy-decision-log');

export interface PolicyDecisionRow {
  id: number;
  at: string;
  intent: string;
  route_hint: string;
  max_retries: number;
  concurrency: number;
  reasoning_depth: string;
  defer_background: number;
  shadow: number;
  shedding: number;
  signals: string;
  reasons: string;
  session_id: string | null;
  turn_id: string | null;
}

export class PolicyDecisionLog {
  private readonly db: Database;

  constructor(dbPath: string = path.join(DATA_DIR, 'gateway.db')) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        at               TEXT NOT NULL,
        intent           TEXT NOT NULL,
        route_hint       TEXT NOT NULL,
        max_retries      INTEGER NOT NULL,
        concurrency      INTEGER NOT NULL,
        reasoning_depth  TEXT NOT NULL,
        defer_background INTEGER NOT NULL DEFAULT 0,
        shadow           INTEGER NOT NULL DEFAULT 0,
        shedding         INTEGER NOT NULL DEFAULT 0,
        signals          TEXT NOT NULL DEFAULT '{}',
        reasons          TEXT NOT NULL DEFAULT '[]',
        session_id       TEXT,
        turn_id          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pd_at     ON policy_decisions(at);
      CREATE INDEX IF NOT EXISTS idx_pd_shadow ON policy_decisions(shadow);
    `);
  }

  /**
   * Build the resolver sink. Optional context ids (session/turn) enable the
   * llm_calls join; the loop wiring supplies them once the resolver rides
   * there with context.
   */
  createSink(context?: { sessionId?: string; turnId?: string }): (entry: PolicyDecisionEntry) => void {
    const stmt = this.db.prepare(`
      INSERT INTO policy_decisions
        (at, intent, route_hint, max_retries, concurrency, reasoning_depth,
         defer_background, shadow, shedding, signals, reasons, session_id, turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return (entry) => {
      try {
        stmt.run(
          entry.at,
          entry.signals.intent ?? 'unknown',
          entry.decision.route,
          entry.decision.maxRetries,
          entry.decision.concurrency,
          entry.decision.reasoningDepth,
          entry.decision.deferBackground ? 1 : 0,
          entry.decision.shadow ? 1 : 0,
          entry.shedding ? 1 : 0,
          JSON.stringify(entry.signals),
          JSON.stringify(entry.decision.reasons),
          context?.sessionId ?? null,
          context?.turnId ?? null,
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'policy decision insert failed — routing unaffected',
        );
      }
    };
  }

  recent(limit = 100): PolicyDecisionRow[] {
    return this.db
      .prepare(`SELECT * FROM policy_decisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as PolicyDecisionRow[];
  }

  close(): void {
    this.db.close();
  }
}
