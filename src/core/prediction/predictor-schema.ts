/**
 * predictor-schema.ts — DDL, types, and row-shape helpers for the Predictor.
 *
 * Kept separate so predictor.ts stays within the 300-line file boundary.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Prediction {
  id: string;
  type: 'content' | 'schedule' | 'revenue' | 'anomaly' | 'action';
  prediction: string;
  confidence: number;         // 0-1
  reasoning: string;
  suggestedAction?: string;
  expiresAt?: string;         // ISO-8601
  outcome?: 'correct' | 'incorrect' | 'pending';
  createdAt: string;          // ISO-8601
}

export interface Anomaly {
  metric: string;
  expected: number;
  actual: number;
  deviation: number;          // percentage deviation
  severity: 'info' | 'warning' | 'critical';
  description: string;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

// NOTE: CREATE TABLE IF NOT EXISTS means the outcome CHECK constraint only
// applies to freshly created databases; pre-existing mind.db files keep the
// unconstrained column (application-layer validation still guards writes).
export const DDL_PREDICTIONS = `
  CREATE TABLE IF NOT EXISTS predictions (
    id              TEXT    PRIMARY KEY,
    type            TEXT    NOT NULL,
    prediction      TEXT    NOT NULL,
    confidence      REAL    DEFAULT 0.5,
    reasoning       TEXT,
    suggested_action TEXT,
    expires_at      TEXT,
    outcome         TEXT    DEFAULT 'pending'
                      CHECK (outcome IN ('correct','incorrect','pending')),
    created_at      TEXT    NOT NULL
                      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_ANOMALIES = `
  CREATE TABLE IF NOT EXISTS anomalies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    metric      TEXT    NOT NULL,
    expected    REAL,
    actual      REAL,
    deviation   REAL,
    severity    TEXT    DEFAULT 'info',
    description TEXT,
    detected_at TEXT    NOT NULL
                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_IDX_PREDICTIONS_TYPE =
  `CREATE INDEX IF NOT EXISTS idx_pred_type ON predictions(type)`;
export const DDL_IDX_PREDICTIONS_OUTCOME =
  `CREATE INDEX IF NOT EXISTS idx_pred_outcome ON predictions(outcome)`;
export const DDL_IDX_ANOMALIES_SEVERITY =
  `CREATE INDEX IF NOT EXISTS idx_anom_severity ON anomalies(severity)`;

// ---------------------------------------------------------------------------
// Row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

export interface PredictionRow {
  id: string;
  type: string;
  prediction: string;
  confidence: number;
  reasoning: string | null;
  suggested_action: string | null;
  expires_at: string | null;
  outcome: string;
  created_at: string;
}

export interface ApiCostRow { total: number | null }

export interface VideoRow {
  title: string | null;
  views: number | null;
  hook_type: string | null;
  topic: string | null;
  avg_view_percentage: number | null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

export function rowToPrediction(r: PredictionRow): Prediction {
  return {
    id: r.id,
    type: r.type as Prediction['type'],
    prediction: r.prediction,
    confidence: r.confidence,
    reasoning: r.reasoning ?? '',
    suggestedAction: r.suggested_action ?? undefined,
    expiresAt: r.expires_at ?? undefined,
    outcome: r.outcome as Prediction['outcome'],
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Return current IST hour (0-23). IST = UTC+5:30. */
export function istHour(): number {
  const istOffset = 5.5 * 60 * 60_000;
  return new Date(Date.now() + istOffset).getUTCHours();
}

/** Return current UTC day-of-week (0=Sunday). */
export function utcDow(): number {
  return new Date().getUTCDay();
}
