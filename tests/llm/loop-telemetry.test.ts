/**
 * AL1.2 loop-telemetry tests: llm_calls gains {session_id, turn_id, step_n,
 * tool} via additive migration, tool executions get their own tool_calls
 * table, and the ambient AsyncLocalStorage loop-step context stamps both —
 * including under concurrent contexts (no cross-session leakage).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GatewayCallLog,
  runWithLoopStep,
  currentLoopStep,
} from '../../src/llm/logging.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'loop-telemetry-'));
  dbPath = path.join(tmpDir, 'gateway.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

describe('schema (AL1.2)', () => {
  it('fresh DB has the four correlation columns and the tool_calls table', () => {
    const log = new GatewayCallLog(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = columns(db, 'llm_calls');
    for (const c of ['session_id', 'turn_id', 'step_n', 'tool']) expect(cols).toContain(c);
    const toolCols = columns(db, 'tool_calls');
    for (const c of ['ts', 'session_id', 'turn_id', 'step_n', 'tool', 'latency_ms', 'outcome']) {
      expect(toolCols).toContain(c);
    }
    db.close();
    void log;
  });

  it('migrates a legacy DB additively (pre-AL1.2 schema gains the columns)', () => {
    // Hand-build the old shape: llm_calls without the new columns.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE llm_calls (
        trace_id TEXT PRIMARY KEY, ts TEXT NOT NULL, caller TEXT NOT NULL,
        purpose TEXT, alias TEXT, route TEXT, priority TEXT,
        ir_request TEXT, ir_response TEXT, wire_payload_sha256 TEXT,
        error_class TEXT, latency_ms INTEGER, ttft_ms INTEGER,
        tokens_in INTEGER, tokens_out INTEGER, tokens_cached INTEGER,
        cost_usd REAL, outcome TEXT
      )
    `);
    // Fresh ts — the constructor prunes rows older than the retention window.
    legacy.prepare(`INSERT INTO llm_calls (trace_id, ts, caller) VALUES ('t0', :ts, 'x')`)
      .run({ ts: new Date().toISOString() });
    legacy.close();

    const log = new GatewayCallLog(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = columns(db, 'llm_calls');
    for (const c of ['content_sha256', 'session_id', 'turn_id', 'step_n', 'tool']) {
      expect(cols).toContain(c);
    }
    // Legacy row survives, new columns NULL.
    const row = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 't0'`).get() as Record<string, unknown>;
    expect(row['caller']).toBe('x');
    expect(row['turn_id']).toBeNull();
    db.close();
    void log;
  });
});

describe('ambient loop-step stamping', () => {
  it('record() inside runWithLoopStep stamps session/turn/step; outside leaves NULLs', async () => {
    const log = new GatewayCallLog(dbPath);

    await runWithLoopStep({ sessionId: 's1', turnId: 'turn-1', stepN: 3 }, async () => {
      log.record({ traceId: 'in-scope', caller: 'agent-loop' });
    });
    log.record({ traceId: 'out-of-scope', caller: 'cognitive-stream' });

    const db = new Database(dbPath, { readonly: true });
    const inScope = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 'in-scope'`).get() as Record<string, unknown>;
    expect(inScope['session_id']).toBe('s1');
    expect(inScope['turn_id']).toBe('turn-1');
    expect(inScope['step_n']).toBe(3);
    const outScope = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 'out-of-scope'`).get() as Record<string, unknown>;
    expect(outScope['session_id']).toBeNull();
    expect(outScope['turn_id']).toBeNull();
    expect(outScope['step_n']).toBeNull();
    db.close();
  });

  it('explicit entry fields win over the ambient context', async () => {
    const log = new GatewayCallLog(dbPath);
    await runWithLoopStep({ sessionId: 's1', turnId: 'ambient', stepN: 1 }, async () => {
      log.record({ traceId: 'explicit', caller: 'agent-loop', turnId: 'explicit-turn', stepN: 9 });
    });
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 'explicit'`).get() as Record<string, unknown>;
    expect(row['turn_id']).toBe('explicit-turn');
    expect(row['step_n']).toBe(9);
    expect(row['session_id']).toBe('s1'); // not overridden — still ambient
    db.close();
  });

  it('concurrent contexts do not leak across async boundaries', async () => {
    const log = new GatewayCallLog(dbPath);
    await Promise.all([
      runWithLoopStep({ sessionId: 'sA', turnId: 'turn-A', stepN: 1 }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        expect(currentLoopStep()?.turnId).toBe('turn-A');
        log.record({ traceId: 'call-A', caller: 'agent-loop' });
      }),
      runWithLoopStep({ sessionId: 'sB', turnId: 'turn-B', stepN: 7 }, async () => {
        expect(currentLoopStep()?.turnId).toBe('turn-B');
        log.record({ traceId: 'call-B', caller: 'agent-loop' });
      }),
    ]);
    const db = new Database(dbPath, { readonly: true });
    const a = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 'call-A'`).get() as Record<string, unknown>;
    const b = db.prepare(`SELECT * FROM llm_calls WHERE trace_id = 'call-B'`).get() as Record<string, unknown>;
    expect(a['turn_id']).toBe('turn-A');
    expect(a['session_id']).toBe('sA');
    expect(b['turn_id']).toBe('turn-B');
    expect(b['step_n']).toBe(7);
    db.close();
  });
});

describe('tool_calls rows', () => {
  it('recordToolCall persists a row, ambient-filling turn/step', async () => {
    const log = new GatewayCallLog(dbPath);
    await runWithLoopStep({ sessionId: 's1', turnId: 'turn-1', stepN: 4 }, async () => {
      log.recordToolCall({ sessionId: 's1', tool: 'browser.scrape', latencyMs: 123, outcome: 'success' });
    });
    log.recordToolCall({ sessionId: 's2', tool: 'files.read', latencyMs: 5, outcome: 'error' });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`SELECT * FROM tool_calls ORDER BY id`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      session_id: 's1', turn_id: 'turn-1', step_n: 4,
      tool: 'browser.scrape', latency_ms: 123, outcome: 'success',
    });
    expect(rows[1]).toMatchObject({ session_id: 's2', tool: 'files.read', outcome: 'error' });
    expect(rows[1]!['turn_id']).toBeNull();
    db.close();
  });

  it('prune() covers tool_calls', () => {
    const log = new GatewayCallLog(dbPath);
    log.recordToolCall({ sessionId: 's', tool: 't', latencyMs: 1, outcome: 'success', ts: '2020-01-01T00:00:00Z' });
    log.recordToolCall({ sessionId: 's', tool: 't', latencyMs: 1, outcome: 'success' });
    const deleted = log.prune(30);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get() as { n: number }).n).toBe(1);
    db.close();
  });
});
