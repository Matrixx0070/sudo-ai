/**
 * @file store.ts
 * @description CW4 — winners AND losers persisted per arbitration (losers are
 * the measurement gold). Own small DB (data/arbiter.db via the DATA_DIR
 * convention); fail-open: storage failure never blocks a turn.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';
import type { ArbiterDecision } from './types.js';

const log = createLogger('consciousness:context-arbiter:store');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(path.join(DATA_DIR, 'arbiter.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS arbiter_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    admitted INTEGER NOT NULL,
    reject_reason TEXT,
    value REAL NOT NULL,
    confidence REAL NOT NULL,
    token_cost INTEGER NOT NULL,
    score REAL NOT NULL,
    budget_tokens INTEGER NOT NULL,
    spent_tokens INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_arbiter_ts ON arbiter_decisions(ts);`);
  return db;
}

/** Persist one arbitration round (all bids, winners and losers). Fail-open. */
export function recordDecision(decision: ArbiterDecision, sessionId?: string): void {
  try {
    const d = getDb();
    const ts = new Date().toISOString();
    const ins = d.prepare(
      `INSERT INTO arbiter_decisions
        (ts, session_id, source, admitted, reject_reason, value, confidence, token_cost, score, budget_tokens, spent_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const all = [...decision.winners, ...decision.losers];
    const tx = d.transaction(() => {
      for (const b of all) {
        ins.run(ts, sessionId ?? null, b.source, b.admitted ? 1 : 0, b.rejectReason ?? null,
          b.value, b.confidence, b.tokenCost, b.score, decision.budgetTokens, decision.spentTokens);
      }
    });
    tx();
  } catch (err) {
    log.warn({ err: String(err) }, 'CW4: recordDecision failed (fail-open)');
  }
}

/** Test/maintenance hook: close the cached handle. */
export function closeArbiterStore(): void {
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}
