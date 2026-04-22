/**
 * @file cognition/cross-signal-diagnostics.ts
 * @description CrossSignalDiagnostics — correlates signals across subsystems to
 * surface meaningful co-occurrences (e.g., trust-tier drops following epistemic
 * block spikes). Pure read-only analyzer — reads existing tables, never writes.
 *
 * Sources:
 *   trust    — trust_outcomes(kind TEXT, ts INTEGER)       [epoch ms]
 *   epistemic — epistemic_log(decision TEXT, ts TEXT)      [ISO-8601]
 *   veto     — audit_chain(learned TEXT, ts INTEGER)       [epoch ms, LIKE '%veto%']
 *   commitment — audit_chain(commitment TEXT, ttl_days, ts INTEGER)  [epoch ms]
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:cross-signal-diagnostics');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_SPIKE_BUCKET_MINUTES = 15;
const DEFAULT_CORRELATION_WINDOW_MINUTES = 30;
const MAX_CORRELATIONS = 10;
const SPIKE_ABSOLUTE_THRESHOLD = 3;
const SPIKE_MEDIAN_MULTIPLIER = 2;
const ROLLING_MEDIAN_BUCKETS = 10;

// ---------------------------------------------------------------------------
// Duck-typed database interface
// ---------------------------------------------------------------------------

interface StatementLike<TResult = unknown> {
  all(...params: unknown[]): TResult[];
}

export interface DatabaseLike {
  prepare<TResult = unknown>(sql: string): StatementLike<TResult>;
  /** Executes one or more SQL statements. Optional to keep mocks that only implement prepare. */
  exec?(sql: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SignalSource = 'trust' | 'epistemic' | 'veto' | 'discordance' | 'commitment';

export interface SignalSpike {
  source: SignalSource;
  kind: string;        // e.g. 'veto', 'epistemic-block', 'commitment-expired'
  ts: number;          // epoch ms (bucket start)
  count: number;       // events in the spike window
}

export interface Correlation {
  leadingSpike: SignalSpike;
  trailingSpike: SignalSpike;
  deltaMs: number;    // trailingSpike.ts - leadingSpike.ts
  confidence: number; // [0,1]
}

export interface DiagnosticsReport {
  windowDays: number;
  trustSpikes: SignalSpike[];
  epistemicBlockSpikes: SignalSpike[];
  vetoSpikes: SignalSpike[];
  commitmentExpirySpikes: SignalSpike[];
  correlations: Correlation[];  // sorted desc by confidence, top 10
  analyzedAt: string;
  totalEventsScanned: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface TrustRow {
  kind: string;
  ts: number;
}

interface EpistemicRow {
  decision: string;
  ts: string; // ISO-8601 TEXT column
}

interface VetoRow {
  learned: string;
  ts: number;
}

interface CommitmentRow {
  commitment: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute the rolling median of the last N values. Returns 0 on empty. */
function rollingMedian(values: number[], lookback: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-lookback);
  const sorted = [...slice].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/** Zero-event report for fail-open returns. */
function zeroReport(windowDays: number): DiagnosticsReport {
  return {
    windowDays,
    trustSpikes: [],
    epistemicBlockSpikes: [],
    vetoSpikes: [],
    commitmentExpirySpikes: [],
    correlations: [],
    analyzedAt: new Date().toISOString(),
    totalEventsScanned: 0,
  };
}

/**
 * Bucket a list of epoch-ms timestamps into fixed-width windows of
 * `bucketMs` milliseconds. Returns a map from bucketStart → count.
 */
function bucketTimestamps(timestamps: number[], bucketMs: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const ts of timestamps) {
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    map.set(bucket, (map.get(bucket) ?? 0) + 1);
  }
  return map;
}

/**
 * Detect spikes from a bucket map.
 * A bucket is a spike if count >= SPIKE_ABSOLUTE_THRESHOLD
 * OR count >= SPIKE_MEDIAN_MULTIPLIER * rollingMedian(last 10 prior buckets).
 */
function detectSpikes(
  buckets: Map<number, number>,
  source: SignalSource,
  kind: string,
): SignalSpike[] {
  // Sort bucket starts ascending for ordered processing
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  const spikes: SignalSpike[] = [];
  const history: number[] = [];

  for (const bucketStart of sortedKeys) {
    const count = buckets.get(bucketStart) ?? 0;
    const median = rollingMedian(history, ROLLING_MEDIAN_BUCKETS);
    const meetsAbsolute = count >= SPIKE_ABSOLUTE_THRESHOLD;
    const meetsRelative = median > 0 && count >= SPIKE_MEDIAN_MULTIPLIER * median;

    if (meetsAbsolute || meetsRelative) {
      spikes.push({ source, kind, ts: bucketStart, count });
    }

    history.push(count);
  }

  return spikes;
}

/**
 * Compute correlations between two spike lists where:
 * 0 < deltaMs <= correlationWindowMs.
 */
function correlateSpikes(
  leading: SignalSpike[],
  trailing: SignalSpike[],
  correlationWindowMs: number,
): Correlation[] {
  const results: Correlation[] = [];

  for (const leadSpike of leading) {
    for (const trailSpike of trailing) {
      const deltaMs = trailSpike.ts - leadSpike.ts;
      if (deltaMs <= 0 || deltaMs > correlationWindowMs) continue;

      const confidence =
        Math.min(1, (leadSpike.count + trailSpike.count) / 10) *
        (1 - deltaMs / correlationWindowMs);

      results.push({
        leadingSpike: leadSpike,
        trailingSpike: trailSpike,
        deltaMs,
        confidence,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CrossSignalDiagnostics
// ---------------------------------------------------------------------------

export class CrossSignalDiagnostics {
  private readonly _trustDb: DatabaseLike;
  private readonly _epistemicDb: DatabaseLike;
  private readonly _auditDb: DatabaseLike;

  // Cached prepared statements (undefined when table init failed)
  private _stmtTrust: StatementLike<TrustRow> | undefined;
  private _stmtEpistemic: StatementLike<EpistemicRow> | undefined;
  private _stmtVeto: StatementLike<VetoRow> | undefined;
  private _stmtCommitment: StatementLike<CommitmentRow> | undefined;

  constructor(opts: {
    trustDb: DatabaseLike;
    epistemicDb: DatabaseLike;
    auditDb: DatabaseLike;
  }) {
    this._trustDb = opts.trustDb;
    this._epistemicDb = opts.epistemicDb;
    this._auditDb = opts.auditDb;

    // Lazy schema seed for audit_chain on the audit DB only.
    // IF NOT EXISTS makes this idempotent on every startup.
    if (this._auditDb.exec) {
      try {
        this._auditDb.exec(`
          CREATE TABLE IF NOT EXISTS audit_chain (
            id         TEXT NOT NULL PRIMARY KEY,
            ts         INTEGER NOT NULL,
            learned    TEXT,
            mistake    TEXT,
            commitment TEXT,
            ttl_days   REAL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_chain_ts ON audit_chain(ts);
        `);
      } catch (err: unknown) {
        log.warn({ err }, 'cross-signal-diagnostics: audit_chain schema seed failed (non-fatal)');
      }
    }

    // Prepare statements eagerly; catch individually so one missing table
    // doesn't prevent the others from being cached.
    try {
      this._stmtTrust = this._trustDb.prepare<TrustRow>(
        `SELECT kind, ts FROM trust_outcomes WHERE ts >= ?`,
      );
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.init.trust' },
        'cross-signal-diagnostics: trust_outcomes not available');
    }

    try {
      this._epistemicDb.exec?.(`
        CREATE TABLE IF NOT EXISTS epistemic_log (
          id               TEXT PRIMARY KEY,
          session_id       TEXT,
          tag              TEXT NOT NULL,
          impact           TEXT NOT NULL,
          decision         TEXT NOT NULL,
          rationale_preview TEXT NOT NULL,
          ts               TEXT NOT NULL
        )
      `);
      this._stmtEpistemic = this._epistemicDb.prepare<EpistemicRow>(
        `SELECT decision, ts FROM epistemic_log WHERE ts >= ?`,
      );
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.init.epistemic' },
        'cross-signal-diagnostics: epistemic_log not available');
    }

    try {
      this._stmtVeto = this._auditDb.prepare<VetoRow>(
        `SELECT learned, ts FROM audit_chain WHERE ts >= ? AND learned LIKE '%veto%'`,
      );
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.init.veto' },
        'cross-signal-diagnostics: audit_chain (veto) not available');
    }

    try {
      this._stmtCommitment = this._auditDb.prepare<CommitmentRow>(
        `SELECT commitment, ts FROM audit_chain WHERE ts >= ? AND commitment IS NOT NULL AND ttl_days IS NOT NULL`,
      );
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.init.commitment' },
        'cross-signal-diagnostics: audit_chain (commitment) not available');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch result containing both the filtered timestamps and the total rows
   * scanned (for totalEventsScanned accounting).
   */
  private _fetchTrustResult(cutoffMs: number): { timestamps: number[]; scanned: number } {
    if (!this._stmtTrust) return { timestamps: [], scanned: 0 };
    try {
      const RELEVANT_KINDS = new Set(['failure', 'veto', 'conjecture-commit', 'commitment-expired']);
      const rows = this._stmtTrust.all(cutoffMs);
      const timestamps = rows
        .filter(r => RELEVANT_KINDS.has(r.kind))
        .map(r => r.ts);
      return { timestamps, scanned: rows.length };
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.fetch.trust' },
        'cross-signal-diagnostics: trust query failed (fail-open)');
      return { timestamps: [], scanned: 0 };
    }
  }

  /** Fetch epistemic REPLAN (block) event timestamps within the window. */
  private _fetchEpistemicResult(cutoffIso: string): { timestamps: number[]; scanned: number } {
    if (!this._stmtEpistemic) return { timestamps: [], scanned: 0 };
    try {
      const rows = this._stmtEpistemic.all(cutoffIso);
      const timestamps = rows
        .filter(r => r.decision === 'REPLAN')
        .map(r => {
          const parsed = Date.parse(r.ts);
          return Number.isFinite(parsed) ? parsed : -1;
        })
        .filter(ts => ts >= 0);
      return { timestamps, scanned: rows.length };
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.fetch.epistemic' },
        'cross-signal-diagnostics: epistemic query failed (fail-open)');
      return { timestamps: [], scanned: 0 };
    }
  }

  /** Fetch veto event timestamps within the window. */
  private _fetchVetoResult(cutoffMs: number): { timestamps: number[]; scanned: number } {
    if (!this._stmtVeto) return { timestamps: [], scanned: 0 };
    try {
      const rows = this._stmtVeto.all(cutoffMs);
      return { timestamps: rows.map(r => r.ts), scanned: rows.length };
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.fetch.veto' },
        'cross-signal-diagnostics: veto query failed (fail-open)');
      return { timestamps: [], scanned: 0 };
    }
  }

  /** Fetch commitment expiry event timestamps within the window. */
  private _fetchCommitmentResult(cutoffMs: number): { timestamps: number[]; scanned: number } {
    if (!this._stmtCommitment) return { timestamps: [], scanned: 0 };
    try {
      const rows = this._stmtCommitment.all(cutoffMs);
      return { timestamps: rows.map(r => r.ts), scanned: rows.length };
    } catch (err: unknown) {
      log.warn({ err, event: 'cross-signal.fetch.commitment' },
        'cross-signal-diagnostics: commitment query failed (fail-open)');
      return { timestamps: [], scanned: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze cross-signal co-occurrences within the rolling window.
   * Fail-open: any unhandled throw returns a zero-event report.
   */
  analyze(opts?: {
    windowDays?: number;
    spikeBucketMinutes?: number;
    correlationWindowMinutes?: number;
  }): DiagnosticsReport {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const spikeBucketMinutes = opts?.spikeBucketMinutes ?? DEFAULT_SPIKE_BUCKET_MINUTES;
    const correlationWindowMinutes = opts?.correlationWindowMinutes ?? DEFAULT_CORRELATION_WINDOW_MINUTES;

    try {
      const cutoffMs = Date.now() - windowDays * MS_PER_DAY;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const bucketMs = spikeBucketMinutes * MS_PER_MINUTE;
      const correlationWindowMs = correlationWindowMinutes * MS_PER_MINUTE;

      // Fetch all sources — track raw row counts for totalEventsScanned
      const trustResult = this._fetchTrustResult(cutoffMs);
      const epistemicResult = this._fetchEpistemicResult(cutoffIso);
      const vetoResult = this._fetchVetoResult(cutoffMs);
      const commitmentResult = this._fetchCommitmentResult(cutoffMs);

      const totalEventsScanned =
        trustResult.scanned +
        epistemicResult.scanned +
        vetoResult.scanned +
        commitmentResult.scanned;

      // Detect spikes per source
      const trustSpikes = detectSpikes(
        bucketTimestamps(trustResult.timestamps, bucketMs), 'trust', 'trust-failure');
      const epistemicBlockSpikes = detectSpikes(
        bucketTimestamps(epistemicResult.timestamps, bucketMs), 'epistemic', 'epistemic-block');
      const vetoSpikes = detectSpikes(
        bucketTimestamps(vetoResult.timestamps, bucketMs), 'veto', 'veto');
      const commitmentExpirySpikes = detectSpikes(
        bucketTimestamps(commitmentResult.timestamps, bucketMs), 'commitment', 'commitment-expired');

      log.debug({
        event: 'cross-signal.analyze',
        windowDays,
        totalEventsScanned,
        trustSpikes: trustSpikes.length,
        epistemicBlockSpikes: epistemicBlockSpikes.length,
        vetoSpikes: vetoSpikes.length,
        commitmentExpirySpikes: commitmentExpirySpikes.length,
      }, 'cross-signal-diagnostics: analysis complete');

      // Cross-correlate all spike pairs across different sources
      const allSpikes: SignalSpike[] = [
        ...trustSpikes,
        ...epistemicBlockSpikes,
        ...vetoSpikes,
        ...commitmentExpirySpikes,
      ];

      const allCorrelations: Correlation[] = [];
      for (let i = 0; i < allSpikes.length; i++) {
        for (let j = 0; j < allSpikes.length; j++) {
          if (i === j) continue;
          const leadSpike = allSpikes[i]!;
          const trailSpike = allSpikes[j]!;
          // Only correlate spikes from different sources
          if (leadSpike.source === trailSpike.source) continue;
          const correlations = correlateSpikes([leadSpike], [trailSpike], correlationWindowMs);
          allCorrelations.push(...correlations);
        }
      }

      // Sort desc by confidence, cap at 10
      allCorrelations.sort((a, b) => b.confidence - a.confidence);
      const correlations = allCorrelations.slice(0, MAX_CORRELATIONS);

      return {
        windowDays,
        trustSpikes,
        epistemicBlockSpikes,
        vetoSpikes,
        commitmentExpirySpikes,
        correlations,
        analyzedAt: new Date().toISOString(),
        totalEventsScanned,
      };
    } catch (err: unknown) {
      log.error({ err, event: 'cross-signal.analyze.error' },
        'cross-signal-diagnostics: unhandled error — returning zero report (fail-open)');
      return zeroReport(windowDays ?? DEFAULT_WINDOW_DAYS);
    }
  }
}
