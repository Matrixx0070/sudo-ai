/**
 * @file cognition/trust-tier-tracker.ts
 * @description TrustTierTracker — records observed outcomes and computes a
 * dynamic trust tier (HIGH | MEDIUM | LOW | PROBATION) for an agent based on
 * a rolling 7-day scoring window. Pure module; no REST wiring (deferred).
 *
 * Storage: SQLite table `trust_outcomes(id, ts, kind, weight)`.
 * Scoring: weighted deltas per outcome kind, clamped to [0,1], tier thresholds
 * at 0.75 / 0.50 / 0.25.
 */

import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:trust-tier-tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 7;
const SCORE_DIVISOR = 20;
const SCORE_MIDPOINT = 0.5;

const TIER_HIGH_THRESHOLD = 0.75;
const TIER_LOW_THRESHOLD = 0.25;
// MEDIUM is [0.50, 0.75), LOW is [0.25, 0.50), PROBATION is [0, 0.25)

// Base delta per outcome kind (applied before user-supplied weight multiplier)
const KIND_DELTAS: Readonly<Record<string, number>> = {
  'success': 1.0,
  'commitment-honored': 1.5,
  'epistemic-block': 0.5,
  'failure': -1.0,
  'veto': -1.5,
  'conjecture-commit': -2.0,
  'commitment-expired': -1.0,
  'injection-detected': -2.5,
  're-anchor': 0.5,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrustTier = 'HIGH' | 'MEDIUM' | 'LOW' | 'PROBATION';

export interface OutcomeRecord {
  timestamp: number;
  kind: 'success' | 'failure' | 'veto' | 'epistemic-block' | 'conjecture-commit' | 'commitment-honored' | 'commitment-expired' | 'injection-detected' | 're-anchor';
  weight?: number; // default 1.0
}

export interface OutcomeBreakdownEntry {
  kind: string;
  count: number;
  score: number;
}

export interface AuditSnapshot {
  tier: TrustTier;
  score: number;
  windowSizeDays: number;
  recentOutcomes: { kind: string; count: number }[];
  lastAdjustedAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface RawOutcomeRow {
  id: string;
  ts: number;
  kind: string;
  weight: number;
}

interface KindCountRow {
  kind: string;
  cnt: number;
}

interface KindBreakdownRow {
  kind: string;
  cnt: number;
  total_weight: number;
}

interface MaxTsRow {
  max_ts: number | null;
}

// ---------------------------------------------------------------------------
// Neutral defaults (fail-open)
// ---------------------------------------------------------------------------

const NEUTRAL_TIER: TrustTier = 'MEDIUM';
const NEUTRAL_SCORE = 0.5;

function neutralSnapshot(): AuditSnapshot {
  return {
    tier: NEUTRAL_TIER,
    score: NEUTRAL_SCORE,
    windowSizeDays: WINDOW_DAYS,
    recentOutcomes: [],
    lastAdjustedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TrustTierTracker
// ---------------------------------------------------------------------------

export class TrustTierTracker {
  private readonly _stmtInsert: Statement<[string, number, string, number]>;
  private readonly _stmtSelectWindow: Statement<[number], RawOutcomeRow>;
  private readonly _stmtCountByKind: Statement<[number], KindCountRow>;
  private readonly _stmtMaxTs: Statement<[number], MaxTsRow>;
  private readonly _stmtBreakdown: Statement<[number], KindBreakdownRow>;

  constructor(private readonly db: Database) {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trust_outcomes (
          id     TEXT NOT NULL PRIMARY KEY,
          ts     INTEGER NOT NULL,
          kind   TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0
        )
      `);
    } catch (err: unknown) {
      log.error({ err, event: 'trust.init.error' }, 'trust-tier-tracker: failed to create table');
      // Subsequent calls will fail-open via per-method try/catch.
    }

    this._stmtInsert = this.db.prepare<[string, number, string, number]>(
      `INSERT INTO trust_outcomes (id, ts, kind, weight) VALUES (?, ?, ?, ?)`,
    );

    this._stmtSelectWindow = this.db.prepare<[number], RawOutcomeRow>(
      `SELECT id, ts, kind, weight FROM trust_outcomes WHERE ts >= ? ORDER BY ts ASC`,
    );

    this._stmtCountByKind = this.db.prepare<[number], KindCountRow>(
      `SELECT kind, COUNT(*) AS cnt FROM trust_outcomes WHERE ts >= ? GROUP BY kind`,
    );

    this._stmtMaxTs = this.db.prepare<[number], MaxTsRow>(
      `SELECT MAX(ts) AS max_ts FROM trust_outcomes WHERE ts >= ?`,
    );

    this._stmtBreakdown = this.db.prepare<[number], KindBreakdownRow>(
      `SELECT kind, COUNT(*) AS cnt, SUM(weight) AS total_weight FROM trust_outcomes WHERE ts >= ? GROUP BY kind`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Epoch ms of the start of the current 7-day rolling window. */
  private _windowStart(): number {
    return Date.now() - WINDOW_DAYS * MS_PER_DAY;
  }

  /**
   * Compute trust score from a set of outcome rows.
   * Returns NEUTRAL_SCORE when the row array is empty.
   */
  private _scoreFromRows(rows: RawOutcomeRow[]): number {
    if (rows.length === 0) {
      return NEUTRAL_SCORE;
    }

    let sum = 0;
    for (const row of rows) {
      const baseDelta = KIND_DELTAS[row.kind] ?? 0;
      sum += baseDelta * row.weight;
    }

    const raw = SCORE_MIDPOINT + sum / SCORE_DIVISOR;
    return Math.max(0, Math.min(1, raw));
  }

  /** Map a numeric score to a tier. */
  private _tierFromScore(score: number): TrustTier {
    if (score >= TIER_HIGH_THRESHOLD) return 'HIGH';
    if (score >= SCORE_MIDPOINT) return 'MEDIUM';
    if (score >= TIER_LOW_THRESHOLD) return 'LOW';
    return 'PROBATION';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record an observed outcome. Fails open: DB errors are logged and swallowed.
   */
  recordOutcome(outcome: OutcomeRecord): void {
    const id = randomUUID();
    const weight = outcome.weight ?? 1.0;

    if (!Number.isFinite(weight) || weight <= 0) {
      log.warn({ outcome, event: 'trust.record.invalid-weight' },
        'trust-tier-tracker: invalid weight, using 1.0');
    }

    const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 1.0;

    try {
      this._stmtInsert.run(id, outcome.timestamp, outcome.kind, safeWeight);
      log.debug({ id, kind: outcome.kind, ts: outcome.timestamp, weight: safeWeight, event: 'trust.outcome.recorded' },
        'trust-tier-tracker: outcome recorded');
    } catch (err: unknown) {
      log.error({ err, outcome, event: 'trust.record.error' },
        'trust-tier-tracker: failed to record outcome (fail-open)');
    }
  }

  /**
   * Return the current trust tier based on the rolling 7-day window.
   * Fails open: returns MEDIUM on any DB error.
   */
  getCurrentTier(): TrustTier {
    try {
      const rows = this._stmtSelectWindow.all(this._windowStart());
      return this._tierFromScore(this._scoreFromRows(rows));
    } catch (err: unknown) {
      log.error({ err, event: 'trust.tier.error' },
        'trust-tier-tracker: failed to compute tier (fail-open)');
      return NEUTRAL_TIER;
    }
  }

  /**
   * Return the raw score (0..1) that determines the current tier.
   * Fails open: returns 0.5 on any DB error.
   */
  getScore(): number {
    try {
      const rows = this._stmtSelectWindow.all(this._windowStart());
      return this._scoreFromRows(rows);
    } catch (err: unknown) {
      log.error({ err, event: 'trust.score.error' },
        'trust-tier-tracker: failed to compute score (fail-open)');
      return NEUTRAL_SCORE;
    }
  }

  /**
   * Return a full audit snapshot of the current window state.
   * Fails open: returns neutral snapshot on any DB error.
   */
  getAuditSnapshot(): AuditSnapshot {
    try {
      const windowStart = this._windowStart();

      const rows = this._stmtSelectWindow.all(windowStart);
      const score = this._scoreFromRows(rows);
      const tier = this._tierFromScore(score);

      const kindRows = this._stmtCountByKind.all(windowStart);
      const recentOutcomes = kindRows.map(r => ({ kind: r.kind, count: r.cnt }));

      const maxTsRow = this._stmtMaxTs.get(windowStart);
      const lastAdjustedAt = maxTsRow?.max_ts != null
        ? new Date(maxTsRow.max_ts).toISOString()
        : new Date().toISOString();

      return {
        tier,
        score,
        windowSizeDays: WINDOW_DAYS,
        recentOutcomes,
        lastAdjustedAt,
      };
    } catch (err: unknown) {
      log.error({ err, event: 'trust.snapshot.error' },
        'trust-tier-tracker: failed to build audit snapshot (fail-open)');
      return neutralSnapshot();
    }
  }

  /**
   * Return a per-kind breakdown of outcomes in the rolling window.
   * Each entry contains the kind, count, and weighted score contribution.
   * Defaults to 7-day window. Fails open: returns empty array on any DB error.
   */
  getOutcomeBreakdown(opts?: { windowDays?: number }): OutcomeBreakdownEntry[] {
    try {
      const days = (opts?.windowDays != null && Number.isFinite(opts.windowDays) && opts.windowDays > 0)
        ? opts.windowDays
        : WINDOW_DAYS;
      const windowStart = Date.now() - days * MS_PER_DAY;
      const rows = this._stmtBreakdown.all(windowStart);
      return rows.map(row => ({
        kind: row.kind,
        count: row.cnt,
        score: (KIND_DELTAS[row.kind] ?? 0) * row.total_weight,
      }));
    } catch (err: unknown) {
      log.error({ err, event: 'trust.breakdown.error' },
        'trust-tier-tracker: getOutcomeBreakdown failed (fail-open)');
      return [];
    }
  }
}
