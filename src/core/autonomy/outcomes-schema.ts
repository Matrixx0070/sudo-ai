/**
 * @file outcomes-schema.ts
 * @description Types, DDL, and row-converter helpers for OutcomesLedger.
 * Kept separate to hold outcomes.ts under 300 lines.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Categorises what kind of outcome was produced. */
export type OutcomeType =
  | 'goal_completed'
  | 'earning'
  | 'task_done'
  | 'tool_success'
  | 'payment'
  | 'error';

/** A single outcome record as returned by the ledger. */
export interface OutcomeEntry {
  id: string;
  type: OutcomeType;
  description: string;
  /** Numeric value associated with this outcome (e.g. dollars earned, score). */
  valueNumeric?: number;
  /** ISO-4217 currency code when type is 'earning' or 'payment'. */
  currency?: string;
  sourceGoalId?: string;
  sourceSessionId?: string;
  /** ISO-8601 timestamp. */
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

/** Input when recording a new outcome — id and recordedAt are auto-assigned. */
export type OutcomeInput = Omit<OutcomeEntry, 'id' | 'recordedAt'>;

/** Filter options for OutcomesLedger.query(). */
export interface OutcomeFilter {
  type?: OutcomeType;
  sourceGoalId?: string;
  sourceSessionId?: string;
  /** ISO-8601 lower bound for recorded_at. */
  since?: string;
  limit?: number;
}

/** Aggregate summary produced by OutcomesLedger.summarize(). */
export interface OutcomeSummary {
  totalCount: number;
  byType: Partial<Record<OutcomeType, number>>;
  /** Sum of valueNumeric where type = 'earning' or 'payment'. */
  totalEarnings: number;
  /** Sum of all valueNumeric values regardless of type. */
  totalValueNumeric: number;
  since?: string;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  id: string;
  type: string;
  description: string;
  value_numeric: number | null;
  currency: string | null;
  source_goal_id: string | null;
  source_session_id: string | null;
  recorded_at: string;
  metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const CREATE_OUTCOMES = `
  CREATE TABLE IF NOT EXISTS outcomes (
    id                TEXT    PRIMARY KEY,
    type              TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    value_numeric     REAL,
    currency          TEXT,
    source_goal_id    TEXT,
    source_session_id TEXT,
    recorded_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    metadata_json     TEXT
  )
`;

export const OUTCOMES_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_outcomes_type        ON outcomes(type)`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_goal_id     ON outcomes(source_goal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_session_id  ON outcomes(source_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_recorded_at ON outcomes(recorded_at)`,
  // ITEM 5: Partial unique index preventing duplicate (session, type) rows.
  // NULL source_session_id rows are excluded from the constraint so ad-hoc
  // ledger entries without a session can coexist freely.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_outcomes_session_type ON outcomes(source_session_id, type) WHERE source_session_id IS NOT NULL`,
];

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initOutcomesSchema(db: Database): void {
  db.exec(CREATE_OUTCOMES);
  for (const idx of OUTCOMES_INDEXES) {
    db.exec(idx);
  }
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

export function rowToEntry(row: OutcomeRow): OutcomeEntry {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch { /* ignore corrupt JSON */ }
  }

  return {
    id:              row.id,
    type:            row.type as OutcomeType,
    description:     row.description,
    valueNumeric:    row.value_numeric ?? undefined,
    currency:        row.currency ?? undefined,
    sourceGoalId:    row.source_goal_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    recordedAt:      row.recorded_at,
    metadata,
  };
}
