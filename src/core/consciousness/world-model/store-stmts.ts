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

let _db: BetterSqlite3DB | null = null;
let _insertStmt: AnyStmt | null = null;
let _getAllStmt: AnyStmt | null = null;
let _getByDomainStmt: AnyStmt | null = null;
let _getByOutcomeStmt: AnyStmt | null = null;
let _getByDomainOutcomeStmt: AnyStmt | null = null;
let _getPendingStmt: AnyStmt | null = null;
let _updateOutcomeStmt: AnyStmt | null = null;
let _expireOldStmt: AnyStmt | null = null;
let _avgConfidenceStmt: AnyStmt | null = null;
let _matchRateStmt: AnyStmt | null = null;
let _getByIdStmt: AnyStmt | null = null;

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
  if (_db !== db) {
    _db = db;

    _insertStmt = db.prepare(`
      INSERT INTO world_model
        (id, domain, prediction, confidence, evidence_count,
         made_at, expires_at, last_validated, outcome, actual_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    _getAllStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       ORDER BY made_at DESC
    `);

    _getByDomainStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE domain = ?
       ORDER BY made_at DESC
    `);

    _getByOutcomeStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE outcome = ?
       ORDER BY made_at DESC
    `);

    _getByDomainOutcomeStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE domain = ? AND outcome = ?
       ORDER BY made_at DESC
    `);

    _getPendingStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE outcome = 'pending'
       ORDER BY made_at ASC
    `);

    _updateOutcomeStmt = db.prepare(`
      UPDATE world_model
         SET outcome = ?,
             actual_result = ?,
             confidence = ?,
             last_validated = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             evidence_count = evidence_count + 1
       WHERE id = ?
    `);

    _expireOldStmt = db.prepare(`
      UPDATE world_model
         SET outcome = 'expired'
       WHERE expires_at IS NOT NULL
         AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND outcome = 'pending'
    `);

    _avgConfidenceStmt = db.prepare(`
      SELECT COALESCE(AVG(confidence), 0.5) AS avg_confidence
        FROM world_model
       WHERE domain = ?
         AND outcome IN ('confirmed', 'violated')
    `);

    // Empirical match rate for a domain: how often resolved predictions were
    // confirmed. `resolved` is the sample size so callers can apply a
    // cold-start floor before trusting `confirmed / resolved`.
    _matchRateStmt = db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
        COUNT(*)                                               AS resolved
        FROM world_model
       WHERE domain = ?
         AND outcome IN ('confirmed', 'violated')
    `);

    _getByIdStmt = db.prepare(`
      SELECT id, domain, prediction, confidence, evidence_count,
             made_at, expires_at, last_validated, outcome, actual_result
        FROM world_model
       WHERE id = ?
    `);
  }

  return {
    insert: _insertStmt!,
    getAll: _getAllStmt!,
    getByDomain: _getByDomainStmt!,
    getByOutcome: _getByOutcomeStmt!,
    getByDomainOutcome: _getByDomainOutcomeStmt!,
    getPending: _getPendingStmt!,
    updateOutcome: _updateOutcomeStmt!,
    expireOld: _expireOldStmt!,
    avgConfidence: _avgConfidenceStmt!,
    matchRate: _matchRateStmt!,
    getById: _getByIdStmt!,
  };
}
