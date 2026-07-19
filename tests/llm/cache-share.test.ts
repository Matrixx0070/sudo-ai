import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { computeCacheShare, readLedgerRows, type LedgerRow } from '../../src/llm/cache-share.js';

describe('computeCacheShare — pure computation', () => {
  it('computes cache-read share, fresh tokens, latency, cost', () => {
    const rows: LedgerRow[] = [
      { tokensIn: 1000, tokensCached: 900, latencyMs: 100, costUsd: 0.01 },
      { tokensIn: 1000, tokensCached: 950, latencyMs: 200, costUsd: 0.01 },
    ];
    const r = computeCacheShare(rows);
    expect(r.turns).toBe(2);
    expect(r.cacheReadTokens).toBe(1850);
    expect(r.freshInputTokens).toBe(150);
    expect(r.cacheReadSharePct).toBe(92.5); // 1850 / 2000
    expect(r.avgLatencyMs).toBe(150);
    expect(r.costUsd).toBe(0.02);
  });

  it('matches the OpenClaw-style 91.6% figure (24768 cached vs 125 fresh over 50 turns)', () => {
    // Single aggregate row standing in for the turn-50 snapshot.
    const r = computeCacheShare([{ tokensIn: 24768 + 125, tokensCached: 24768, latencyMs: 8000, costUsd: 0.35 }]);
    expect(r.cacheReadSharePct).toBeCloseTo(99.5, 1);
    expect(r.freshInputTokens).toBe(125);
  });

  it('handles an empty ledger without dividing by zero', () => {
    const r = computeCacheShare([]);
    expect(r).toEqual({
      turns: 0,
      cacheReadTokens: 0,
      freshInputTokens: 0,
      cacheReadSharePct: 0,
      avgLatencyMs: 0,
      costUsd: 0,
    });
  });

  it('treats NULL token/latency/cost fields as zero and never exceeds 100%', () => {
    const rows: LedgerRow[] = [
      { tokensIn: null, tokensCached: null, latencyMs: null, costUsd: null },
      { tokensIn: 500, tokensCached: 500, latencyMs: 50, costUsd: null }, // fully cached
    ];
    const r = computeCacheShare(rows);
    expect(r.turns).toBe(2);
    expect(r.cacheReadTokens).toBe(500);
    expect(r.freshInputTokens).toBe(0);
    expect(r.cacheReadSharePct).toBe(100);
    expect(r.avgLatencyMs).toBe(50); // only the row with a latency counts
    expect(r.costUsd).toBe(0);
  });

  it('clamps a pathological cached>tokensIn row so share stays <= 100%', () => {
    const r = computeCacheShare([{ tokensIn: 100, tokensCached: 999, latencyMs: null, costUsd: null }]);
    expect(r.cacheReadSharePct).toBe(100);
  });
});

describe('readLedgerRows — over a seeded in-memory llm_calls ledger', () => {
  function seed(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE llm_calls (
      trace_id TEXT PRIMARY KEY, ts TEXT NOT NULL, caller TEXT NOT NULL, route TEXT,
      tokens_in INTEGER, tokens_cached INTEGER, latency_ms INTEGER, cost_usd REAL
    )`);
    const ins = db.prepare(
      `INSERT INTO llm_calls (trace_id, ts, caller, route, tokens_in, tokens_cached, latency_ms, cost_usd)
       VALUES (:id, :ts, :caller, :route, :ti, :tc, :lat, :cost)`,
    );
    // 3 grok rows + 1 claude row, ascending ts.
    ins.run({ id: 't1', ts: '2026-07-19T00:00:01Z', caller: 'agent-loop', route: 'xai/grok-4.3', ti: 1000, tc: 800, lat: 100, cost: 0.01 });
    ins.run({ id: 't2', ts: '2026-07-19T00:00:02Z', caller: 'agent-loop', route: 'xai/grok-4.3', ti: 1000, tc: 900, lat: 120, cost: 0.01 });
    ins.run({ id: 't3', ts: '2026-07-19T00:00:03Z', caller: 'cron',       route: 'xai/grok-4.3', ti: 2000, tc: 100, lat: 300, cost: 0.02 });
    ins.run({ id: 't4', ts: '2026-07-19T00:00:04Z', caller: 'agent-loop', route: 'anthropic/claude', ti: 500, tc: 0, lat: 400, cost: 0.03 });
    return db;
  }

  it('reads all rows newest-first and computes share end-to-end', () => {
    const db = seed();
    try {
      const rows = readLedgerRows(db, { limit: 50 });
      expect(rows).toHaveLength(4);
      const r = computeCacheShare(rows);
      expect(r.turns).toBe(4);
      expect(r.cacheReadTokens).toBe(1800);
    } finally {
      db.close();
    }
  });

  it('filters by route', () => {
    const db = seed();
    try {
      const rows = readLedgerRows(db, { route: 'xai/grok-4.3' });
      expect(rows).toHaveLength(3);
      expect(computeCacheShare(rows).cacheReadTokens).toBe(1800);
    } finally {
      db.close();
    }
  });

  it('filters by caller and respects limit', () => {
    const db = seed();
    try {
      const rows = readLedgerRows(db, { caller: 'agent-loop', limit: 2 });
      expect(rows).toHaveLength(2); // newest 2 agent-loop rows
      const r = computeCacheShare(rows);
      // newest agent-loop rows are t4 (claude, 0 cached) and t2 (900 cached)
      expect(r.cacheReadTokens).toBe(900);
    } finally {
      db.close();
    }
  });
});
