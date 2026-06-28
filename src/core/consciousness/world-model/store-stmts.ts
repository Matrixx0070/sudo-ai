/**
 * @file store-stmts.ts
 * @description Internal: SQLite row types, row converter, and cached statement
 * factory for the world-model store.
 *
 * Not part of the public barrel — imported only by store.ts.
 */

import type Database from 'better-sqlite3';
type BetterSqlite3DB = Database.Database;
type AnyStmt = ReturnType<BetterSqlite3DB['prepare']>;
import type { WorldModelEntry } from './types.js';

// ---------------------------------------------------------------------------
// DB row shape (snake_case, as returned by SQLite)
// ---------------------------------------------------------------------------

export interface WorldModelRow {
  id: string;
  domain: string;
  prediction: string;
  confidence: number;
  evidence_count: number;
  made_at: string;
  expires_at: string | null;
  last_validated: string | null;
  outcome: string;
  actual_result: string | null;
}

// ---------------------------------------------------------------------------
// Row converter: snake_case → camelCase
// ---------------------------------------------------------------------------

export function rowToEntry(row: WorldModelRow): WorldModelEntry {
  return {
    id: row.id,
    domain: row.domain,
    prediction: row.prediction,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    madeAt: row.made_at,
    expiresAt: row.expires_at,
    lastValidated: row.last_validated,
    outcome: row.outcome as WorldModelEntry['outcome'],
    actualResult: row.actual_result,
  };
}

// ---------------------------------------------------------------------------
// Cached statement factory (one set per db instance)
// ---------------------------------------------------------------------------

// Per-DB statement cache. A WeakMap keyed by the db handle means each
// ConsciousnessDB instance keeps its OWN prepared statements — constructing a
// second instance (tests / hot-reload) no longer invalidates and rebuilds the
// shared singleton out from under in-flight code holding the old cache.
const _cache = new WeakMap<BetterSqlite3DB, StatementsCache>();

export interface StatementsCache {
  insert: AnyStmt;
  getAll: AnyStmt;
  getByDomain: AnyStmt;
  getByOutcome: AnyStmt;
  getByDomainOutcome: AnyStmt;
  getPending: AnyStmt;
  updateOutcome: AnyStmt;
  expireOld: AnyStmt;
  avgConfidence: AnyStmt;
  matchRate: AnyStmt;
  getById: AnyStmt;
}

export function getStatements(db: BetterSqlite3DB): StatementsCache {
  const hit = _cache.get(db);
  if (hit) return hit;

  const built: StatementsCache = {
    insert: db.prepare(`
      INSERT INTO world_model
        (id, domain, prediction, confidence, evidence_count,
         made_at, expires_at, last_validated, outcome, actual_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getAll: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       ORDER BY made_at DESC
    `),

    getByDomain: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE domain = ?
       ORDER BY made_at DESC
    `),

    getByOutcome: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE outcome = ?
       ORDER BY made_at DESC
    `),

    getByDomainOutcome: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE domain = ? AND outcome = ?
       ORDER BY made_at DESC
    `),

    getPending: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE outcome = 'pending'
       ORDER BY made_at ASC
    `),

    updateOutcome: db.prepare(`
      UPDATE world_model
         SET outcome = ?,
             actual_result = ?,
             confidence = ?,
             last_validated = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             evidence_count = evidence_count + 1
       WHERE id = ?
    `),

    expireOld: db.prepare(`
      UPDATE world_model
         SET outcome = 'expired'
       WHERE expires_at IS NOT NULL
         AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND outcome = 'pending'
    `),

    avgConfidence: db.prepare(`
      SELECT COALESCE(AVG(confidence), 0.5) AS avg_confidence
        FROM world_model
       WHERE domain = ?
         AND outcome IN ('confirmed', 'violated')
    `),

    // Empirical match rate for a domain: how often resolved predictions were
    // confirmed. `resolved` is the sample size so callers can apply a
    // cold-start floor before trusting `confirmed / resolved`.
    matchRate: db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
        COUNT(*)                                               AS resolved
        FROM world_model
       WHERE domain = ?
         AND outcome IN ('confirmed', 'violated')
    `),

    getById: db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE id = ?
    `),
  };

  _cache.set(db, built);
  return built;
}
