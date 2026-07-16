/**
 * Watchdog cache-hit-rate observability (src/llm/cache/hit-rate.ts).
 *
 * Seeds a temp DATA_DIR/gateway.db with llm_calls rows (alias/tokens_in/
 * tokens_cached) and verifies the per-provider + blended cache-read rate, the
 * sync Prometheus accessor, the min-sample/kill-switch/floor branches, and the
 * throttle.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let dbPath: string;

function seed(rows: Array<{ alias: string; tin: number; tc: number }>): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
    trace_id TEXT PRIMARY KEY, ts TEXT NOT NULL, caller TEXT, alias TEXT,
    tokens_in INTEGER, tokens_cached INTEGER)`);
  const ins = db.prepare('INSERT OR REPLACE INTO llm_calls (trace_id, ts, caller, alias, tokens_in, tokens_cached) VALUES (?,?,?,?,?,?)');
  const ts = new Date().toISOString();
  rows.forEach((r, i) => ins.run(`t${i}`, ts, 'agent', r.alias, r.tin, r.tc));
  db.close();
}

async function freshModule() {
  vi.resetModules();
  process.env['DATA_DIR'] = dir;
  return await import('../../../src/llm/cache/hit-rate.js');
}

const KEYS = ['DATA_DIR', 'SUDO_CACHE_HIT_MIN_SAMPLE', 'SUDO_CACHE_HIT_WARN_PCT', 'SUDO_CACHE_HIT_WATCH_DISABLE', 'SUDO_CACHE_HIT_WINDOW_HOURS', 'SUDO_CACHE_HIT_CHECK_INTERVAL_MS'];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hitrate-'));
  dbPath = path.join(dir, 'gateway.db');
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_CACHE_HIT_MIN_SAMPLE'] = '4';
  for (const k of ['SUDO_CACHE_HIT_WARN_PCT', 'SUDO_CACHE_HIT_WATCH_DISABLE', 'SUDO_CACHE_HIT_WINDOW_HOURS', 'SUDO_CACHE_HIT_CHECK_INTERVAL_MS']) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) delete process.env[k];
});

describe('checkCacheHitRate', () => {
  it('computes blended + per-provider read rate, sorted by input volume', async () => {
    // xai: 1000 in / 300 cached = 30% (bigger volume); claude: 200 in / 120 = 60%
    seed([
      { alias: 'xai-oauth/grok-4.5', tin: 500, tc: 150 },
      { alias: 'xai-oauth/grok-4.5', tin: 500, tc: 150 },
      { alias: 'claude-oauth/claude-fable-5', tin: 100, tc: 60 },
      { alias: 'claude-oauth/claude-fable-5', tin: 100, tc: 60 },
    ]);
    const m = await freshModule();
    const check = await m.checkCacheHitRate();
    expect(check.name).toBe('cache_hit_rate');
    expect(check.status).toBe('healthy');
    const snap = m.lastCacheHitSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.blendedPct).toBe(35); // 420 cached / 1200 in
    expect(snap!.byProvider[0]!.provider).toBe('xai-oauth'); // biggest volume first
    expect(snap!.byProvider[0]!.readPct).toBe(30);
    expect(snap!.byProvider[1]!.provider).toBe('claude-oauth');
    expect(snap!.byProvider[1]!.readPct).toBe(60);
    expect(m.lastBlendedCacheReadPct()).toBe(35); // sync accessor for Prometheus
    expect(check.message).toContain('xai-oauth 30%');
  });

  it('healthy "no signal" below min sample', async () => {
    seed([{ alias: 'xai-oauth/grok', tin: 100, tc: 10 }]);
    const m = await freshModule();
    const check = await m.checkCacheHitRate();
    expect(check.status).toBe('healthy');
    expect(check.message).toContain('no signal');
  });

  it('kill switch disables the probe', async () => {
    process.env['SUDO_CACHE_HIT_WATCH_DISABLE'] = '1';
    seed(Array.from({ length: 6 }, () => ({ alias: 'xai/g', tin: 100, tc: 0 })));
    const m = await freshModule();
    const check = await m.checkCacheHitRate();
    expect(check.message).toContain('disabled');
    expect(m.lastBlendedCacheReadPct()).toBe(0); // never computed
  });

  it('degrades only when a floor is set and blended is below it', async () => {
    process.env['SUDO_CACHE_HIT_WARN_PCT'] = '50';
    seed(Array.from({ length: 6 }, () => ({ alias: 'xai/g', tin: 100, tc: 20 }))); // 20% blended
    const m = await freshModule();
    const check = await m.checkCacheHitRate();
    expect(check.status).toBe('degraded');
    expect(check.message).toContain('below 50% floor');
  });

  it('throttles: a second call within the interval returns the cached verdict', async () => {
    seed(Array.from({ length: 6 }, () => ({ alias: 'xai/g', tin: 100, tc: 50 })));
    const m = await freshModule();
    const first = await m.checkCacheHitRate();
    // change the DB; without recompute the snapshot must be unchanged
    seed(Array.from({ length: 6 }, (_, i) => ({ alias: 'xai/g', tin: 100, tc: 0 })));
    const second = await m.checkCacheHitRate();
    expect(second.message).toBe(first.message); // cached, not recomputed
    expect(m.lastBlendedCacheReadPct()).toBe(50);
  });

  it('fail-open when the db is missing (no gateway.db)', async () => {
    // do not seed → no table/db file
    const m = await freshModule();
    const check = await m.checkCacheHitRate();
    expect(check.status).toBe('healthy'); // telemetry never fails the daemon
  });
});
