/**
 * gw-refactor Phase 5: GatewayCallLog storage module (src/llm/logging.ts).
 *
 * Each test gets its own temp-dir sqlite db. Rows are verified by opening the
 * db file directly with better-sqlite3 — no reliance on the class's readers.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GatewayCallLog,
  getGatewayCallLog,
  __resetGatewayCallLog,
  sha256Hex,
  type LLMCallRecord,
} from '../../src/llm/logging.js';

interface LlmCallRow {
  trace_id: string;
  ts: string;
  caller: string;
  purpose: string | null;
  alias: string | null;
  route: string | null;
  priority: string | null;
  ir_request: string | null;
  ir_response: string | null;
  wire_payload_sha256: string | null;
  error_class: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  cost_usd: number | null;
  outcome: string | null;
}

let dir: string;
let dbPath: string;
let log: GatewayCallLog;

function readRow(traceId: string): LlmCallRow | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM llm_calls WHERE trace_id = ?').get(traceId) as LlmCallRow | undefined;
  } finally {
    db.close();
  }
}

function countRows(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function baseEntry(overrides: Partial<LLMCallRecord> = {}): LLMCallRecord {
  return {
    traceId: 'trace-1',
    caller: 'agent-loop',
    purpose: 'chat',
    alias: 'fast',
    route: 'anthropic/claude-x',
    priority: 'interactive',
    irRequest: { messages: [{ role: 'user', content: 'hello' }] },
    irResponse: { text: 'hi there' },
    wirePayloadSha256: sha256Hex('{"final":"payload"}'),
    latencyMs: 123,
    ttftMs: 45,
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 5,
    costUsd: 0.0012,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gateway-log-test-'));
  dbPath = path.join(dir, 'gateway.db');
  log = new GatewayCallLog(dbPath);
});

afterEach(() => {
  log.close();
  __resetGatewayCallLog();
  rmSync(dir, { recursive: true, force: true });
});

describe('GatewayCallLog.record', () => {
  it('persists a row with sane fields and round-trippable IR JSON', () => {
    log.record(baseEntry());

    const row = readRow('trace-1');
    expect(row).toBeDefined();
    expect(row!.caller).toBe('agent-loop');
    expect(row!.purpose).toBe('chat');
    expect(row!.alias).toBe('fast');
    expect(row!.route).toBe('anthropic/claude-x');
    expect(row!.priority).toBe('interactive');
    expect(row!.latency_ms).toBe(123);
    expect(row!.ttft_ms).toBe(45);
    expect(row!.tokens_in).toBe(10);
    expect(row!.tokens_out).toBe(20);
    expect(row!.tokens_cached).toBe(5);
    expect(row!.cost_usd).toBeCloseTo(0.0012);
    expect(row!.outcome).toBeNull();
    expect(row!.error_class).toBeNull();
    // ts is ISO-8601 and parseable
    expect(Number.isNaN(Date.parse(row!.ts))).toBe(false);
    expect(row!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // IR JSON parses back to the original (nothing sensitive in it)
    const ir = JSON.parse(row!.ir_request!) as { messages: Array<{ role: string; content: string }> };
    expect(ir.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(JSON.parse(row!.ir_response!)).toEqual({ text: 'hi there' });
    expect(row!.wire_payload_sha256).toBe(sha256Hex('{"final":"payload"}'));
  });

  it('duplicate trace_id replaces the row (INSERT OR REPLACE, last write wins)', () => {
    log.record(baseEntry({ outcome: 'first' }));
    log.record(baseEntry({ caller: 'retry-path', latencyMs: 999, outcome: undefined }));

    expect(countRows()).toBe(1);
    const row = readRow('trace-1')!;
    expect(row.caller).toBe('retry-path');
    expect(row.latency_ms).toBe(999);
    // REPLACE is wholesale: the earlier outcome does not survive.
    expect(row.outcome).toBeNull();
  });

  it('never throws when the underlying db is closed (write failure tolerated)', () => {
    log.close();
    expect(() => log.record(baseEntry({ traceId: 'trace-after-close' }))).not.toThrow();
    expect(() => log.markOutcome('trace-after-close', 'accepted')).not.toThrow();
  });
});

describe('redaction before persist', () => {
  it('scrubs sensitive keys and Bearer-token string leaves from IR payloads', () => {
    log.record(baseEntry({
      traceId: 'trace-redact',
      irRequest: {
        api_key: 'sk-live-abc',
        nested: { Authorization: 'Bearer xyz' },
        messages: [{ role: 'user', content: 'my token is Bearer secret123 ok?' }],
      },
      irResponse: { text: 'use Bearer secret123 for auth' },
    }));

    const row = readRow('trace-redact')!;
    const reqJson = row.ir_request!;
    const respJson = row.ir_response!;

    // Raw secret values must not be persisted anywhere.
    expect(reqJson).not.toContain('sk-live-abc');
    expect(reqJson).not.toContain('Bearer xyz');
    expect(reqJson).not.toContain('secret123');
    expect(respJson).not.toContain('secret123');

    // Structure survives — keys are present, values redacted.
    const req = JSON.parse(reqJson) as {
      api_key: string;
      nested: { Authorization: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(req.api_key).toBe('<redacted>');
    expect(req.nested.Authorization).toBe('<redacted>');
    expect(req.messages[0]!.content).toContain('[REDACTED]');
  });
});

describe('markOutcome', () => {
  it('updates the outcome of an existing row', () => {
    log.record(baseEntry({ traceId: 'trace-outcome' }));
    log.markOutcome('trace-outcome', 'accepted');
    expect(readRow('trace-outcome')!.outcome).toBe('accepted');
  });

  it('is a no-op for a missing trace_id', () => {
    log.record(baseEntry({ traceId: 'trace-exists' }));
    expect(() => log.markOutcome('trace-missing', 'accepted')).not.toThrow();
    expect(countRows()).toBe(1);
    expect(readRow('trace-exists')!.outcome).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('matches the known sha256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // Byte input hashes identically to its string form.
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('retention prune', () => {
  it('removes rows older than the retention window and keeps fresh ones', () => {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    log.record(baseEntry({ traceId: 'trace-old', ts: oldTs }));
    log.record(baseEntry({ traceId: 'trace-new' }));

    const deleted = log.prune(30);
    expect(deleted).toBe(1);
    expect(readRow('trace-old')).toBeUndefined();
    expect(readRow('trace-new')).toBeDefined();
  });

  it('retentionDays=0 keeps everything', () => {
    const oldTs = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    log.record(baseEntry({ traceId: 'trace-ancient', ts: oldTs }));
    expect(log.prune(0)).toBe(0);
    expect(readRow('trace-ancient')).toBeDefined();
  });
});

describe('singleton accessor', () => {
  it('getGatewayCallLog returns the same instance until __resetGatewayCallLog', () => {
    __resetGatewayCallLog();
    const a = getGatewayCallLog(path.join(dir, 'singleton.db'));
    const b = getGatewayCallLog(path.join(dir, 'ignored-second-path.db'));
    expect(a).toBe(b);
    __resetGatewayCallLog();
    const c = getGatewayCallLog(path.join(dir, 'singleton2.db'));
    expect(c).not.toBe(a);
  });
});
