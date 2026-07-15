/**
 * Watchdog cache-dup-rate check (src/llm/cache/dup-watch.ts).
 *
 * Uses a temp DATA_DIR/gateway.db seeded with full-IR rows so the check reads
 * a real table. Verifies: below-threshold → healthy, at/above → degraded,
 * insufficient sample → healthy (no signal), stub rows ignored, kill switch,
 * throttle (second call within interval returns the cached verdict).
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DATA_DIR is read at import time by dup-watch → set env BEFORE importing.
let dir: string;
let dbPath: string;

function seed(rows: Array<{ trace_id: string; system: string; error_class?: string | null; stub?: boolean }>): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
    trace_id TEXT PRIMARY KEY, ts TEXT NOT NULL, caller TEXT NOT NULL, ir_request TEXT, error_class TEXT)`);
  const ins = db.prepare('INSERT OR REPLACE INTO llm_calls (trace_id, ts, caller, ir_request, error_class) VALUES (?,?,?,?,?)');
  const ts = new Date().toISOString();
  for (const r of rows) {
    const ir = r.stub
      ? JSON.stringify({ input_count: 1, model: 'text-embedding-3-small' })
      : JSON.stringify({ alias: 'sudo/frontier', caller: 'agent', purpose: 'p', system: r.system, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], priority: 'user', trace_id: r.trace_id });
    ins.run(r.trace_id, ts, 'agent', ir, r.error_class ?? null);
  }
  db.close();
}

async function freshModule() {
  vi.resetModules();
  process.env['DATA_DIR'] = dir;
  return await import('../../../src/llm/cache/dup-watch.js');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dupwatch-'));
  dbPath = path.join(dir, 'gateway.db');
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_CACHE_DUP_MIN_SAMPLE'] = '10';
  process.env['SUDO_CACHE_DUP_WARN_PCT'] = '30';
  delete process.env['SUDO_CACHE_DUP_WATCH_DISABLE'];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['DATA_DIR', 'SUDO_CACHE_DUP_MIN_SAMPLE', 'SUDO_CACHE_DUP_WARN_PCT', 'SUDO_CACHE_DUP_WATCH_DISABLE']) delete process.env[k];
});

describe('checkCacheDupRate', () => {
  it('healthy when dup rate is below threshold (all distinct)', async () => {
    seed(Array.from({ length: 12 }, (_, i) => ({ trace_id: `t${i}`, system: `unique-${i}` })));
    const { checkCacheDupRate } = await freshModule();
    const c = await checkCacheDupRate();
    expect(c.status).toBe('healthy');
    expect(c.name).toBe('cache_dup_rate');
  });

  it('degraded when dup rate crosses the warn threshold', async () => {
    // 12 rows, all identical content → ~92% dup, ≥30% threshold.
    seed(Array.from({ length: 12 }, (_, i) => ({ trace_id: `t${i}`, system: 'same' })));
    const { checkCacheDupRate } = await freshModule();
    const c = await checkCacheDupRate();
    expect(c.status).toBe('degraded');
    expect(c.message).toMatch(/exact-dup/);
  });

  it('ignores stub rows and error rows (not real cacheable requests)', async () => {
    // 12 identical STUBS (no messages) + 12 identical ERROR rows → 0 admissible → below min sample → healthy
    seed([
      ...Array.from({ length: 12 }, (_, i) => ({ trace_id: `s${i}`, system: 'x', stub: true })),
      ...Array.from({ length: 12 }, (_, i) => ({ trace_id: `e${i}`, system: 'same', error_class: 'billing' })),
    ]);
    const { checkCacheDupRate } = await freshModule();
    const c = await checkCacheDupRate();
    expect(c.status).toBe('healthy');
    expect(c.message).toMatch(/min sample|no signal/);
  });

  it('healthy (no signal) when below min sample', async () => {
    seed([{ trace_id: 'a', system: 'same' }, { trace_id: 'b', system: 'same' }]);
    const { checkCacheDupRate } = await freshModule();
    const c = await checkCacheDupRate();
    expect(c.status).toBe('healthy');
    expect(c.message).toMatch(/min sample|no signal/);
  });

  it('kill switch → healthy, no DB read', async () => {
    process.env['SUDO_CACHE_DUP_WATCH_DISABLE'] = '1';
    const { checkCacheDupRate } = await freshModule(); // no seed → would throw if it read
    const c = await checkCacheDupRate();
    expect(c.status).toBe('healthy');
    expect(c.message).toMatch(/disabled/);
  });

  it('throttles: second call within interval returns cached verdict', async () => {
    seed(Array.from({ length: 12 }, (_, i) => ({ trace_id: `t${i}`, system: 'same' })));
    const { checkCacheDupRate, __resetCacheDupWatch } = await freshModule();
    __resetCacheDupWatch();
    const first = await checkCacheDupRate();
    expect(first.status).toBe('degraded');
    // Wipe the table; a non-throttled recompute would flip to healthy/no-signal.
    const db = new Database(dbPath); db.exec('DELETE FROM llm_calls'); db.close();
    const second = await checkCacheDupRate();
    expect(second.status).toBe('degraded'); // cached, not recomputed
  });

  it('fail-open: missing DB → healthy', async () => {
    // no seed() → gateway.db does not exist
    const { checkCacheDupRate } = await freshModule();
    const c = await checkCacheDupRate();
    expect(c.status).toBe('healthy');
  });
});
