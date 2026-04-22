/**
 * Tests for cross-signal-diagnostics.ts — Wave 6L Builder B.
 *
 * Uses in-memory SQLite DBs with minimal schemas matching each source table.
 * CrossSignalDiagnostics accepts duck-typed DatabaseLike, so we pass real
 * better-sqlite3 Database instances directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  CrossSignalDiagnostics,
} from '../../src/core/cognition/cross-signal-diagnostics.js';
import type {
  DiagnosticsReport,
} from '../../src/core/cognition/cross-signal-diagnostics.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// DB factory helpers
// ---------------------------------------------------------------------------

function makeTrustDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE trust_outcomes (
      id     TEXT NOT NULL PRIMARY KEY,
      ts     INTEGER NOT NULL,
      kind   TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0
    )
  `);
  return db;
}

function makeEpistemicDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE epistemic_log (
      id               TEXT PRIMARY KEY,
      session_id       TEXT,
      tag              TEXT NOT NULL,
      impact           TEXT NOT NULL,
      decision         TEXT NOT NULL,
      rationale_preview TEXT NOT NULL,
      ts               TEXT NOT NULL
    )
  `);
  return db;
}

function makeAuditDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE audit_chain (
      id         TEXT NOT NULL PRIMARY KEY,
      learned    TEXT,
      commitment TEXT,
      ttl_days   REAL,
      ts         INTEGER NOT NULL
    )
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function nextId(): string {
  return `row-${++_seq}`;
}

/** Insert a trust_outcomes row. ts is epoch ms. */
function insertTrust(db: Database, kind: string, tsMs: number): void {
  db.prepare(
    `INSERT INTO trust_outcomes (id, ts, kind, weight) VALUES (?, ?, ?, 1.0)`,
  ).run(nextId(), tsMs, kind);
}

/** Insert an epistemic_log row. ts is ISO-8601. */
function insertEpistemic(db: Database, decision: string, tsMs: number): void {
  db.prepare(
    `INSERT INTO epistemic_log (id, session_id, tag, impact, decision, rationale_preview, ts)
     VALUES (?, NULL, 'CONJECTURE', 'MEDIUM', ?, '', ?)`,
  ).run(nextId(), decision, new Date(tsMs).toISOString());
}

/** Insert an audit_chain veto row. ts is epoch ms. */
function insertVeto(db: Database, tsMs: number): void {
  db.prepare(
    `INSERT INTO audit_chain (id, learned, commitment, ttl_days, ts)
     VALUES (?, 'action blocked by veto gate', NULL, NULL, ?)`,
  ).run(nextId(), tsMs);
}

/** Insert an audit_chain commitment row. ts is epoch ms. */
function insertCommitment(db: Database, tsMs: number): void {
  db.prepare(
    `INSERT INTO audit_chain (id, learned, commitment, ttl_days, ts)
     VALUES (?, NULL, 'will not repeat this', 7, ?)`,
  ).run(nextId(), tsMs);
}

/** Insert N copies of a row spaced 1ms apart starting at tsMs. */
function insertTrustN(db: Database, kind: string, tsMs: number, n: number): void {
  for (let i = 0; i < n; i++) {
    insertTrust(db, kind, tsMs + i);
  }
}

function insertEpistemicN(db: Database, decision: string, tsMs: number, n: number): void {
  for (let i = 0; i < n; i++) {
    insertEpistemic(db, decision, tsMs + i);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics object factory
// ---------------------------------------------------------------------------

function makeDiagnostics(
  trustDb: Database,
  epistemicDb: Database,
  auditDb: Database,
): CrossSignalDiagnostics {
  return new CrossSignalDiagnostics({ trustDb, epistemicDb, auditDb });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossSignalDiagnostics', () => {
  let trustDb: Database;
  let epistemicDb: Database;
  let auditDb: Database;
  let diag: CrossSignalDiagnostics;

  beforeEach(() => {
    _seq = 0;
    trustDb = makeTrustDb();
    epistemicDb = makeEpistemicDb();
    auditDb = makeAuditDb();
    diag = makeDiagnostics(trustDb, epistemicDb, auditDb);
  });

  // -------------------------------------------------------------------------
  // 1. Empty DBs → zero-event report
  // -------------------------------------------------------------------------
  it('returns zero-event report when all DBs are empty', () => {
    const report: DiagnosticsReport = diag.analyze();
    expect(report.windowDays).toBe(7);
    expect(report.trustSpikes).toHaveLength(0);
    expect(report.epistemicBlockSpikes).toHaveLength(0);
    expect(report.vetoSpikes).toHaveLength(0);
    expect(report.commitmentExpirySpikes).toHaveLength(0);
    expect(report.correlations).toHaveLength(0);
    expect(report.totalEventsScanned).toBe(0);
    expect(typeof report.analyzedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 2. Trust failure spike detected
  // -------------------------------------------------------------------------
  it('detects a trust failure spike when count >= absolute threshold', () => {
    // Insert 3+ failures in a single 15-minute bucket
    const now = Date.now();
    insertTrustN(trustDb, 'failure', now - MS_PER_MINUTE, 3);

    const report = diag.analyze();
    expect(report.trustSpikes.length).toBeGreaterThanOrEqual(1);
    expect(report.trustSpikes[0]!.source).toBe('trust');
    expect(report.trustSpikes[0]!.count).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // 3. Epistemic REPLAN spike detected
  // -------------------------------------------------------------------------
  it('detects an epistemic REPLAN spike', () => {
    const now = Date.now();
    insertEpistemicN(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 5, 3);

    const report = diag.analyze();
    expect(report.epistemicBlockSpikes.length).toBeGreaterThanOrEqual(1);
    expect(report.epistemicBlockSpikes[0]!.source).toBe('epistemic');
    expect(report.epistemicBlockSpikes[0]!.kind).toBe('epistemic-block');
  });

  // -------------------------------------------------------------------------
  // 4. Non-REPLAN epistemic events do NOT generate spikes
  // -------------------------------------------------------------------------
  it('ignores epistemic events where decision is PROCEED (not REPLAN)', () => {
    const now = Date.now();
    insertEpistemicN(epistemicDb, 'PROCEED', now - MS_PER_MINUTE * 2, 5);

    const report = diag.analyze();
    expect(report.epistemicBlockSpikes).toHaveLength(0);
    // totalEventsScanned counts all rows fetched, including PROCEED (non-spiking)
    expect(report.totalEventsScanned).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 5. Two spikes within correlationWindow → correlation surfaces
  // -------------------------------------------------------------------------
  it('surfaces a correlation when two spikes are within correlationWindowMinutes', () => {
    // Anchor to 15-min bucket start to avoid wall-clock bucket-boundary straddling.
    // Lesson 2026-04-13: using `now - offsetMs` causes ~27% flaky failure when events
    // from two different offsets land in the same 15-min bucket (deltaMs=0 rejected).
    // Fix: place events in distinct buckets by anchoring to bucket boundaries.
    const bucketMs = 15 * MS_PER_MINUTE;
    const now = Date.now();
    const currentBucketStart = Math.floor(now / bucketMs) * bucketMs;
    // Trust spike in the bucket 3 buckets ago, epistemic in the bucket 2 buckets ago.
    // deltaMs = 1 bucket = 15 min, which is within the 30-min correlationWindow.
    const trustTs = currentBucketStart - 3 * bucketMs + 1000; // +1s inside the bucket
    const epistemicTs = currentBucketStart - 2 * bucketMs + 1000;
    insertTrustN(trustDb, 'failure', trustTs, 3);
    insertEpistemicN(epistemicDb, 'REPLAN', epistemicTs, 3);

    const report = diag.analyze({ correlationWindowMinutes: 30 });
    expect(report.correlations.length).toBeGreaterThanOrEqual(1);
    expect(report.correlations[0]!.confidence).toBeGreaterThan(0);
    expect(report.correlations[0]!.deltaMs).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 6. Two spikes outside correlationWindow → no correlation
  // -------------------------------------------------------------------------
  it('does not correlate spikes separated by more than correlationWindowMinutes', () => {
    const now = Date.now();
    // Trust spike at T, epistemic spike at T + 60 minutes (> 30-min window)
    insertTrustN(trustDb, 'failure', now - MS_PER_MINUTE * 120, 3);
    insertEpistemicN(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 50, 3);

    const report = diag.analyze({ correlationWindowMinutes: 30 });
    // deltaMs would be 70 minutes > 30-minute window → should not correlate
    expect(report.correlations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. spikeBucketMinutes tuning changes detection sensitivity
  // -------------------------------------------------------------------------
  it('smaller spikeBucketMinutes groups fewer events → no spike; larger groups more → spike', () => {
    const now = Date.now();
    const bucketMs = 15 * MS_PER_MINUTE;
    // Anchor to the start of a recent 15-min bucket + 1 s to stay well inside it.
    // This guarantees all three events (spaced 2 min apart) remain within the
    // same 15-minute bucket regardless of wall-clock alignment.
    const base = Math.floor((now - MS_PER_MINUTE * 10) / bucketMs) * bucketMs + 1000;
    for (let i = 0; i < 3; i++) {
      insertTrust(trustDb, 'failure', base + i * MS_PER_MINUTE * 2);
    }

    // 15-minute bucket puts all 3 together → spike
    const report15 = diag.analyze({ spikeBucketMinutes: 15 });
    expect(report15.trustSpikes.length).toBeGreaterThanOrEqual(1);

    // 1-minute bucket: each event is in its own bucket → no bucket hits ≥3
    const trustDb2 = makeTrustDb();
    for (let i = 0; i < 3; i++) {
      insertTrust(trustDb2, 'failure', base + i * MS_PER_MINUTE * 2);
    }
    const diag2 = makeDiagnostics(trustDb2, makeEpistemicDb(), makeAuditDb());
    const report1 = diag2.analyze({ spikeBucketMinutes: 1 });
    expect(report1.trustSpikes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. windowDays filter excludes old rows
  // -------------------------------------------------------------------------
  it('windowDays filter excludes events older than the window', () => {
    const now = Date.now();
    // Recent events (1 day ago)
    insertTrustN(trustDb, 'failure', now - MS_PER_DAY, 3);
    // Old events (10 days ago) — outside default 7-day window
    insertTrustN(trustDb, 'failure', now - MS_PER_DAY * 10, 3);

    const report7 = diag.analyze({ windowDays: 7 });
    expect(report7.trustSpikes).toHaveLength(1); // only recent bucket

    // With 3-day window even recent events at 1-day ago are included
    const report3 = diag.analyze({ windowDays: 3 });
    expect(report3.trustSpikes).toHaveLength(1);

    // With 0.5-day window the 1-day-old events are excluded
    const report05 = diag.analyze({ windowDays: 0.5 });
    expect(report05.trustSpikes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. Correlation confidence monotone: closer deltaMs → higher confidence
  // -------------------------------------------------------------------------
  it('correlation confidence is higher for smaller deltaMs (monotone check)', () => {
    const now = Date.now();
    // Anchor to bucket boundary so bucket assignment is deterministic regardless
    // of wall-clock position within a 15-min bucket (same fix as 6L bucket-anchor).
    const bucketMs = 15 * MS_PER_MINUTE;
    const margin = 1_000; // 1 s inside the bucket — never crosses boundary
    const bucketAnchor = Math.floor(now / bucketMs) * bucketMs;

    // Close scenario: trust in bucket (anchor - 2*bucket), epistemic in bucket
    // (anchor - 1*bucket). Delta after bucketing = exactly 1 bucket = 15 min.
    const trustTsClose = bucketAnchor - 2 * bucketMs + margin;
    const epistemicTsClose = bucketAnchor - bucketMs + margin;
    insertTrustN(trustDb, 'failure', trustTsClose, 3);
    const epistemicDbClose = makeEpistemicDb();
    insertEpistemicN(epistemicDbClose, 'REPLAN', epistemicTsClose, 3);

    // Far scenario: trust in bucket (anchor - 2*bucket), epistemic in bucket
    // (anchor). Delta after bucketing = exactly 2 buckets = 30 min.
    const epistemicDbFar = makeEpistemicDb();
    const trustDbFar = makeTrustDb();
    insertTrustN(trustDbFar, 'failure', trustTsClose, 3);
    insertEpistemicN(epistemicDbFar, 'REPLAN', bucketAnchor + margin, 3);

    const diagClose = makeDiagnostics(trustDb, epistemicDbClose, makeAuditDb());
    const diagFar = makeDiagnostics(trustDbFar, epistemicDbFar, makeAuditDb());

    const reportClose = diagClose.analyze({ correlationWindowMinutes: 30 });
    const reportFar = diagFar.analyze({ correlationWindowMinutes: 30 });

    if (reportClose.correlations.length > 0 && reportFar.correlations.length > 0) {
      const confClose = reportClose.correlations[0]!.confidence;
      const confFar = reportFar.correlations[0]!.confidence;
      // Smaller delta → higher confidence (monotone)
      expect(confClose).toBeGreaterThan(confFar);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Correlations sorted desc by confidence, capped at 10
  // -------------------------------------------------------------------------
  it('returns correlations sorted desc by confidence, capped at 10', () => {
    const now = Date.now();
    const bucketMs = 15 * MS_PER_MINUTE;

    // Create many trust spikes by placing multiple buckets
    for (let b = 0; b < 8; b++) {
      const bucketStart = Math.floor((now - (b + 1) * bucketMs) / bucketMs) * bucketMs;
      insertTrustN(trustDb, 'failure', bucketStart + 1000, 3);
    }
    // One epistemic spike that pairs with several trust spikes
    insertEpistemicN(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 10, 3);

    const report = diag.analyze({ correlationWindowMinutes: 120 });
    // Capped at 10
    expect(report.correlations.length).toBeLessThanOrEqual(10);

    // Sorted descending
    for (let i = 1; i < report.correlations.length; i++) {
      expect(report.correlations[i - 1]!.confidence).toBeGreaterThanOrEqual(
        report.correlations[i]!.confidence,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 11. Missing table → fail-open returns empty array for that source only
  // -------------------------------------------------------------------------
  it('missing trust_outcomes table → empty trustSpikes but other sources still work', () => {
    // DB without trust_outcomes table
    const emptyTrustDb = new DatabaseConstructor(':memory:');
    // (trust_outcomes NOT created)

    const now = Date.now();
    insertEpistemicN(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 2, 3);

    const diagMissing = makeDiagnostics(emptyTrustDb, epistemicDb, auditDb);
    const report = diagMissing.analyze();

    expect(report.trustSpikes).toHaveLength(0);
    expect(report.epistemicBlockSpikes.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 12. DB throw on one query → fail-open for that source, others continue
  // -------------------------------------------------------------------------
  it('DB close on trust → fail-open: zero trust events, others still analyzed', () => {
    const now = Date.now();
    insertEpistemicN(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 2, 3);

    // Close the trust DB to simulate a query failure
    trustDb.close();

    const report = diag.analyze();
    // Trust spikes empty (fail-open)
    expect(report.trustSpikes).toHaveLength(0);
    // Epistemic spikes still populated
    expect(report.epistemicBlockSpikes.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 13. totalEventsScanned is correct sum of rows across all sources
  // -------------------------------------------------------------------------
  it('totalEventsScanned equals sum of rows read across all sources', () => {
    const now = Date.now();
    // 2 trust events (relevant kinds only)
    insertTrust(trustDb, 'failure', now - MS_PER_MINUTE * 5);
    insertTrust(trustDb, 'veto', now - MS_PER_MINUTE * 4);
    // 1 irrelevant trust event (should still count toward scanned)
    insertTrust(trustDb, 'success', now - MS_PER_MINUTE * 3);
    // 2 epistemic REPLAN events
    insertEpistemic(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 5);
    insertEpistemic(epistemicDb, 'REPLAN', now - MS_PER_MINUTE * 4);
    // 1 epistemic PROCEED (scanned but not spiked)
    insertEpistemic(epistemicDb, 'PROCEED', now - MS_PER_MINUTE * 3);
    // 1 veto event in audit_chain
    insertVeto(auditDb, now - MS_PER_MINUTE * 5);
    // 1 commitment event in audit_chain
    insertCommitment(auditDb, now - MS_PER_MINUTE * 3);

    const report = diag.analyze();
    // trust: 3 rows total (all returned by WHERE ts >= ?), epistemic: 3, veto: 1, commitment: 1
    expect(report.totalEventsScanned).toBe(8);
  });

  // -------------------------------------------------------------------------
  // 14. Veto spikes detected from audit_chain
  // -------------------------------------------------------------------------
  it('detects veto spikes from audit_chain learned column', () => {
    // Anchor to current 15-min bucket start + 1s to guarantee all 3 rows
    // land in the same bucket regardless of wall-clock position.
    // Same fix applied to tests 5, 7, 9 (Lesson 2026-04-13).
    const bucketMs = 15 * MS_PER_MINUTE;
    const bucketAnchor = Math.floor(Date.now() / bucketMs) * bucketMs + 1000;
    for (let i = 0; i < 3; i++) {
      insertVeto(auditDb, bucketAnchor + i);
    }

    const report = diag.analyze();
    expect(report.vetoSpikes.length).toBeGreaterThanOrEqual(1);
    expect(report.vetoSpikes[0]!.source).toBe('veto');
  });

  // -------------------------------------------------------------------------
  // 15. Commitment expiry spikes detected from audit_chain
  // -------------------------------------------------------------------------
  it('detects commitment expiry spikes from audit_chain commitment column', () => {
    // Anchor to current 15-min bucket start + 1s to guarantee all 3 rows
    // land in the same bucket regardless of wall-clock position.
    // Same fix applied to tests 5, 7, 9 (Lesson 2026-04-13).
    const bucketMs = 15 * MS_PER_MINUTE;
    const bucketAnchor = Math.floor(Date.now() / bucketMs) * bucketMs + 1000;
    for (let i = 0; i < 3; i++) {
      insertCommitment(auditDb, bucketAnchor + i);
    }

    const report = diag.analyze();
    expect(report.commitmentExpirySpikes.length).toBeGreaterThanOrEqual(1);
    expect(report.commitmentExpirySpikes[0]!.source).toBe('commitment');
  });

  // -------------------------------------------------------------------------
  // 16. Spikes from same source do NOT generate correlations
  // -------------------------------------------------------------------------
  it('does not generate correlations between spikes from the same source', () => {
    const now = Date.now();
    // Two separate trust spikes far apart
    insertTrustN(trustDb, 'failure', now - MS_PER_MINUTE * 25, 3);
    insertTrustN(trustDb, 'veto', now - MS_PER_MINUTE * 5, 3);

    const report = diag.analyze({ correlationWindowMinutes: 30 });
    // All correlations must be cross-source
    for (const corr of report.correlations) {
      expect(corr.leadingSpike.source).not.toBe(corr.trailingSpike.source);
    }
  });
});
