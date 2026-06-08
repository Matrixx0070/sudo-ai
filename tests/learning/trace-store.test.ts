/**
 * Tests for TraceStore — SQLite-backed execution trace store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TraceStore, resolveAggWindowModifier, toSqliteTimestamp } from '../../src/core/learning/trace-store.js';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';

describe('TraceStore', () => {
  let store: TraceStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `sudo-trace-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'traces.db');
    store = new TraceStore(dbPath);
    await store.init();
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // 1. record and query
  it('record and query: records a trace and queries it back', () => {
    const id = store.record({
      traceType: 'tool_call',
      sessionId: 's1',
      toolName: 'read-file',
      success: true,
      latencyMs: 120,
    });
    expect(id).toBeGreaterThan(0);

    const results = store.query({ sessionId: 's1' });
    expect(results).toHaveLength(1);
    expect(results[0].traceType).toBe('tool_call');
    expect(results[0].toolName).toBe('read-file');
    expect(results[0].success).toBe(true);
    expect(results[0].latencyMs).toBe(120);
  });

  // 2. recordToolCall
  it('recordToolCall: convenience method creates correct trace_type', () => {
    const id = store.recordToolCall('s2', 'write-file', true, 250);
    expect(id).toBeGreaterThan(0);

    const results = store.query({ type: 'tool_call' });
    expect(results).toHaveLength(1);
    expect(results[0].traceType).toBe('tool_call');
    expect(results[0].toolName).toBe('write-file');
    expect(results[0].sessionId).toBe('s2');
    expect(results[0].success).toBe(true);
    expect(results[0].latencyMs).toBe(250);
  });

  // 3. recordBrainCall
  it('recordBrainCall: convenience method creates correct trace_type', () => {
    const id = store.recordBrainCall('s3', 'claude-opus', true, 1500, {
      prompt: 500, completion: 200, total: 700,
    });
    expect(id).toBeGreaterThan(0);

    const results = store.query({ type: 'brain_call' });
    expect(results).toHaveLength(1);
    expect(results[0].traceType).toBe('brain_call');
    expect(results[0].model).toBe('claude-opus');
    expect(results[0].sessionId).toBe('s3');
    expect(results[0].tokenUsage).toEqual({ prompt: 500, completion: 200, total: 700 });
    expect(results[0].latencyMs).toBe(1500);
  });

  // 4. recordRouting
  it('recordRouting: convenience method creates routing trace', () => {
    const id = store.recordRouting('s4', 'claude-sonnet', 'coding', 'llm', 0.95);
    expect(id).toBeGreaterThan(0);

    const results = store.query({ type: 'routing' });
    expect(results).toHaveLength(1);
    expect(results[0].traceType).toBe('routing');
    expect(results[0].model).toBe('claude-sonnet');
    expect(results[0].routingTier).toBe('llm');
    expect(results[0].routingConfidence).toBe(0.95);
    expect(results[0].category).toBe('coding');
    expect(results[0].success).toBe(true);
  });

  // 5. query by model
  it('query by model: filters traces by model name', () => {
    store.recordBrainCall('s5', 'claude-opus', true, 1000);
    store.recordBrainCall('s5', 'claude-sonnet', true, 800);
    store.recordBrainCall('s5', 'claude-opus', true, 900);

    const opus = store.query({ model: 'claude-opus' });
    expect(opus).toHaveLength(2);
    expect(opus.every(r => r.model === 'claude-opus')).toBe(true);

    const sonnet = store.query({ model: 'claude-sonnet' });
    expect(sonnet).toHaveLength(1);
    expect(sonnet[0].model).toBe('claude-sonnet');
  });

  // 6. query by success
  it('query by success: filters by success/failure', () => {
    store.recordToolCall('s6', 'read-file', true, 100);
    store.recordToolCall('s6', 'write-file', false, 200, {
      type: 'tool_error', message: 'disk full',
    });
    store.recordToolCall('s6', 'exec', true, 50);

    const successes = store.query({ success: true });
    expect(successes).toHaveLength(2);
    expect(successes.every(r => r.success)).toBe(true);

    const failures = store.query({ success: false });
    expect(failures).toHaveLength(1);
    expect(failures[0].success).toBe(false);
    expect(failures[0].errorType).toBe('tool_error');
    expect(failures[0].errorMessage).toBe('disk full');
  });

  // 7. query by time range
  it('query by time range: filters by since/until', () => {
    // SQLite datetime('now') uses 'YYYY-MM-DD HH:MM:SS' format (no T/Z suffix).
    // Match that format so string comparisons in WHERE clauses work correctly.
    const toSqliteTs = (d: Date) =>
      d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const oneHourAgo = toSqliteTs(new Date(Date.now() - 3600_000));
    const oneHourAhead = toSqliteTs(new Date(Date.now() + 3600_000));

    store.record({ traceType: 'tool_call', success: true, latencyMs: 10 });

    const since = store.query({ since: oneHourAgo });
    expect(since.length).toBeGreaterThanOrEqual(1);

    const future = store.query({ since: oneHourAhead });
    expect(future).toHaveLength(0);

    const range = store.query({ since: oneHourAgo, until: oneHourAhead });
    expect(range.length).toBeGreaterThanOrEqual(1);
  });

  // 8. aggregates
  it('aggregates: refreshAggregates() computes correct stats', () => {
    for (let i = 0; i < 5; i++) {
      store.record({
        traceType: 'tool_call', model: 'claude-opus', toolName: 'search',
        success: true, latencyMs: 100,
      });
    }
    store.record({
      traceType: 'tool_call', model: 'claude-opus', toolName: 'search',
      success: false, latencyMs: 200, errorType: 'timeout',
    });
    store.refreshAggregates();

    const modelTool = store.getAggregates('model_tool', '%claude-opus%');
    const agg = modelTool.find(a => a.key === 'claude-opus:search');
    expect(agg).toBeDefined();
    expect(agg!.totalCalls).toBe(6);
    expect(agg!.successCount).toBe(5);

    const toolErr = store.getAggregates('tool_error');
    const errAgg = toolErr.find(a => a.key === 'search:timeout');
    expect(errAgg).toBeDefined();
    expect(errAgg!.totalCalls).toBe(1);
  });

  // 9. errorClusters
  it('errorClusters: groups errors by type and tool', () => {
    for (let i = 0; i < 3; i++) {
      store.recordToolCall('s9', 'deploy', false, 5000, {
        type: 'auth', message: `Auth failed ${i}`,
      });
    }
    store.recordToolCall('s9', 'exec', false, 50, {
      type: 'rate_limit', message: 'Slow down',
    });

    const clusters = store.getErrorClusters('2000-01-01T00:00:00Z');
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    const authCluster = clusters.find(c => c.errorType === 'auth' && c.toolName === 'deploy');
    expect(authCluster).toBeDefined();
    expect(authCluster!.count).toBe(3);
    expect(authCluster!.recentErrors.length).toBeGreaterThanOrEqual(1);

    const rateCluster = clusters.find(c => c.errorType === 'rate_limit' && c.toolName === 'exec');
    expect(rateCluster).toBeDefined();
    expect(rateCluster!.count).toBe(1);
    expect(rateCluster!.recentErrors).toContain('Slow down');
  });

  // 10. count
  it('count: returns correct counts with filters', () => {
    store.recordToolCall('s10', 'a', true, 10);
    store.recordToolCall('s10', 'b', true, 20);
    store.recordBrainCall('s10', 'claude-opus', true, 100);

    expect(store.count()).toBe(3);
    expect(store.count('tool_call')).toBe(2);
    expect(store.count('brain_call')).toBe(1);
    expect(store.count('routing')).toBe(0);
  });

  // 11. concurrent writes
  it('concurrent writes: multiple writes do not corrupt data', () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      store.recordToolCall(`session-${i}`, `tool-${i}`, i % 2 === 0, i * 10);
    }

    expect(store.count()).toBe(N);
    const all = store.query({});
    expect(all).toHaveLength(N);
    // Verify no data corruption: each session appears exactly once
    const sessions = new Set(all.map(r => r.sessionId));
    expect(sessions.size).toBe(N);
  });

  // 12. WAL mode
  it('WAL mode: database uses WAL journal mode', async () => {
    const mod = await import('better-sqlite3');
    const Driver = (mod as any).default ?? mod;
    const rawDb = new Driver(dbPath);
    const row = rawDb.pragma('journal_mode')[0] as Record<string, string>;
    rawDb.close();

    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  // 13b. ISO-vs-space created_at regression: an ISO since/until must compare
  //      correctly against the space-format created_at the store actually stores.
  it('query() normalizes ISO since/until to match space-format created_at', async () => {
    // Insert a trace at a fixed space-format created_at via a raw connection
    // (record() always defaults created_at to now, so we set it directly here).
    const mod = await import('better-sqlite3');
    const Driver = (mod as any).default ?? mod;
    const raw = new Driver(dbPath);
    raw.prepare(
      `INSERT INTO traces (trace_type, tool_name, success, created_at) VALUES (?, ?, ?, ?)`,
    ).run('tool_call', 'noon-tool', 1, '2026-06-08 12:00:00');
    raw.close();

    // ISO cutoff earlier the SAME day must INCLUDE the noon row. Before the fix,
    // '2026-06-08 12:00:00' < '2026-06-08T00:00:00.000Z' (' ' < 'T'), so it was
    // wrongly dropped.
    expect(store.query({ since: '2026-06-08T00:00:00.000Z' }).some(r => r.toolName === 'noon-tool')).toBe(true);
    // ISO cutoff later the same day must EXCLUDE it (ordering still correct).
    expect(store.query({ since: '2026-06-08T18:00:00.000Z' }).some(r => r.toolName === 'noon-tool')).toBe(false);
    // until (upper bound) is normalized too.
    expect(store.query({ until: '2026-06-08T06:00:00.000Z' }).some(r => r.toolName === 'noon-tool')).toBe(false);
    expect(store.query({ until: '2026-06-08T18:00:00.000Z' }).some(r => r.toolName === 'noon-tool')).toBe(true);
  });

  // 13c. count() must normalize an ISO since the same way query() does.
  it('count() normalizes ISO since to match space-format created_at', async () => {
    const mod = await import('better-sqlite3');
    const Driver = (mod as any).default ?? mod;
    const raw = new Driver(dbPath);
    raw.prepare(
      `INSERT INTO traces (trace_type, tool_name, success, created_at) VALUES (?, ?, ?, ?)`,
    ).run('tool_call', 'noon-tool', 1, '2026-06-08 12:00:00');
    raw.close();

    // ISO cutoff earlier the same day → counts the noon row (silently dropped before the fix).
    expect(store.count('tool_call', '2026-06-08T00:00:00.000Z')).toBe(1);
    // ISO cutoff later the same day → excludes it.
    expect(store.count('tool_call', '2026-06-08T18:00:00.000Z')).toBe(0);
  });

  // 13. aggregation recency window (SUDO_POLICY_AGG_WINDOW_DAYS) — epic follow-up #3.
  //     Default OFF scans the whole table; when set, old traces are excluded.
  it('refreshAggregates honors SUDO_POLICY_AGG_WINDOW_DAYS (default OFF = full scan)', async () => {
    // A recent trace (created_at defaults to datetime('now')).
    store.record({ traceType: 'tool_call', model: 'm', toolName: 't', success: true, latencyMs: 100 });
    // An ancient trace inserted via a raw connection so we control created_at
    // (record() always defaults created_at to now). SQLite datetime format.
    const mod = await import('better-sqlite3');
    const Driver = (mod as any).default ?? mod;
    const raw = new Driver(dbPath);
    raw.prepare(
      `INSERT INTO traces (trace_type, model, tool_name, success, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('tool_call', 'm', 't', 1, 100, '2000-01-01 00:00:00');
    raw.close();

    const prev = process.env['SUDO_POLICY_AGG_WINDOW_DAYS'];
    try {
      // Default OFF: full-table scan includes the year-2000 trace → 2 calls.
      delete process.env['SUDO_POLICY_AGG_WINDOW_DAYS'];
      store.refreshAggregates();
      let agg = store.getAggregates('model_tool', '%m:t%').find(a => a.key === 'm:t');
      expect(agg?.totalCalls).toBe(2);

      // Windowed to the last day: the year-2000 trace is excluded → 1 call.
      process.env['SUDO_POLICY_AGG_WINDOW_DAYS'] = '1';
      store.refreshAggregates();
      agg = store.getAggregates('model_tool', '%m:t%').find(a => a.key === 'm:t');
      expect(agg?.totalCalls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env['SUDO_POLICY_AGG_WINDOW_DAYS'];
      else process.env['SUDO_POLICY_AGG_WINDOW_DAYS'] = prev;
    }
  });
});

describe('resolveAggWindowModifier', () => {
  it('returns undefined for unset / blank / zero / negative / fractional / junk (fail-open)', () => {
    expect(resolveAggWindowModifier(undefined)).toBeUndefined();
    expect(resolveAggWindowModifier('')).toBeUndefined();
    expect(resolveAggWindowModifier('   ')).toBeUndefined();
    expect(resolveAggWindowModifier('0')).toBeUndefined();    // zero-day window would exclude everything
    expect(resolveAggWindowModifier('-7')).toBeUndefined();
    expect(resolveAggWindowModifier('7.5')).toBeUndefined();
    expect(resolveAggWindowModifier('abc')).toBeUndefined();
    expect(resolveAggWindowModifier('7d')).toBeUndefined();
  });

  it('returns a SQLite datetime modifier for a positive integer (whitespace tolerated)', () => {
    expect(resolveAggWindowModifier('1')).toBe('-1 days');
    expect(resolveAggWindowModifier('7')).toBe('-7 days');
    expect(resolveAggWindowModifier('  30  ')).toBe('-30 days');
  });
});

describe('toSqliteTimestamp', () => {
  it('converts ISO 8601 to SQLite datetime format', () => {
    expect(toSqliteTimestamp('2026-06-08T12:00:00.000Z')).toBe('2026-06-08 12:00:00');
    expect(toSqliteTimestamp('2026-06-08T12:00:00Z')).toBe('2026-06-08 12:00:00');
    expect(toSqliteTimestamp('2000-01-01T00:00:00.123Z')).toBe('2000-01-01 00:00:00');
  });

  it('leaves an already space-formatted timestamp unchanged (idempotent)', () => {
    expect(toSqliteTimestamp('2026-06-08 12:00:00')).toBe('2026-06-08 12:00:00');
    expect(toSqliteTimestamp(toSqliteTimestamp('2026-06-08T12:00:00.000Z'))).toBe('2026-06-08 12:00:00');
  });
});