/** F123 — metabolism report. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildMetabolismReport, LOOP_REGISTRY } from '../../src/core/health/metabolism-report.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'f123-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('buildMetabolismReport (F123)', () => {
  it('attributes 24h spend by source from api_call_log and writes the JSON report', () => {
    const db = new Database(path.join(dir, 'mind.db'));
    db.exec('CREATE TABLE api_call_log (source TEXT, estimated_cost_usd REAL, called_at TEXT)');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    db.prepare('INSERT INTO api_call_log VALUES (?,?,?)').run('consciousness', 0.5, now);
    db.prepare('INSERT INTO api_call_log VALUES (?,?,?)').run('consciousness', 0.25, now);
    db.prepare('INSERT INTO api_call_log VALUES (?,?,?)').run('heartbeat', 1.0, now);
    db.prepare('INSERT INTO api_call_log VALUES (?,?,?)').run('heartbeat', 9.0, old); // outside window
    db.close();
    const report = buildMetabolismReport(dir);
    expect(report.totalUsd24h).toBeCloseTo(1.75);
    expect(report.spendBySource24h[0]).toMatchObject({ source: 'heartbeat', usd: 1 });
    expect(report.spendBySource24h.find((r) => r.source === 'consciousness')?.calls).toBe(2);
    const written = JSON.parse(readFileSync(path.join(dir, 'metabolism-report.json'), 'utf8'));
    expect(written.loops.length).toBe(LOOP_REGISTRY.length);
  });

  it('works without mind.db (empty spend, still writes registry)', () => {
    const report = buildMetabolismReport(dir);
    expect(report.spendBySource24h).toEqual([]);
    expect(existsSync(path.join(dir, 'metabolism-report.json'))).toBe(true);
  });
});
