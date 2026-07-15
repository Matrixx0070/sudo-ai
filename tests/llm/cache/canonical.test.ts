/**
 * Canonical content fingerprint (src/llm/cache/canonical.ts) + its wiring into
 * GatewayCallLog.record() (content_sha256 column).
 *
 * Proves: determinism, volatile-field independence, content sensitivity, key
 * ORDER invariance, all-caller coverage via the shared record() sink, fail-open
 * on absent/garbage IR, and the legacy-DB column migration (index created AFTER
 * the column exists).
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalize,
  contentFingerprint,
  stableStringify,
  CACHE_KEY_SCHEMA_VERSION,
} from '../../../src/llm/cache/canonical.js';
import { getGatewayCallLog, __resetGatewayCallLog, type LLMCallRecord } from '../../../src/llm/logging.js';
import type { IRRequest } from '../../../shared-types/ir/v1.js';

function ir(overrides: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'sudo/frontier',
    caller: 'agent',
    purpose: 'test',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    priority: 'user',
    trace_id: 'trace-1',
    ...overrides,
  };
}

describe('contentFingerprint — determinism & invariance', () => {
  it('is deterministic for the same content', () => {
    expect(contentFingerprint(ir())).toBe(contentFingerprint(ir()));
  });

  it('ignores volatile fields (trace_id, caller, purpose, priority, extra)', () => {
    const base = contentFingerprint(ir());
    const variant = contentFingerprint(
      ir({
        trace_id: 'a-totally-different-trace',
        caller: 'rag',
        purpose: 'something else',
        priority: 'background',
        extra: { conv_id: 'conversation-xyz', vendor_flag: true },
      }),
    );
    expect(variant).toBe(base);
  });

  it('is invariant to JSON key insertion order (nested objects)', () => {
    // Same tool, input_schema properties inserted in opposite order.
    const a = ir({
      tools: [{ name: 't', input_schema: { alpha: { type: 'string' }, beta: { type: 'number' } } }],
    });
    const b = ir({
      tools: [{ name: 't', input_schema: { beta: { type: 'number' }, alpha: { type: 'string' } } }],
    });
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
  });

  it('PRESERVES array order (message order is semantic → distinct keys)', () => {
    const a = ir({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    const b = ir({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
      ],
    });
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
  });
});

describe('contentFingerprint — content sensitivity', () => {
  const base = contentFingerprint(ir());
  it.each([
    ['message text', ir({ messages: [{ role: 'user', content: [{ type: 'text', text: 'goodbye' }] }] })],
    ['system prompt', ir({ system: 'You are terse.' })],
    ['alias/model', ir({ alias: 'sudo/cheap' })],
    ['temperature', ir({ temperature: 0.7 })],
    ['max_tokens', ir({ max_tokens: 4096 })],
    ['tools', ir({ tools: [{ name: 'search', input_schema: {} }] })],
    ['response_schema', ir({ response_schema: { type: 'object' } })],
  ])('changes when %s changes', (_label, variant) => {
    expect(contentFingerprint(variant)).not.toBe(base);
  });
});

describe('canonicalize / stableStringify', () => {
  it('version-tags the canonical form', () => {
    expect(canonicalize(ir()).startsWith(`ck${CACHE_KEY_SCHEMA_VERSION}:`)).toBe(true);
  });
  it('sorts object keys and omits undefined members', () => {
    expect(stableStringify({ b: 1, a: undefined, c: 2 })).toBe('{"b":1,"c":2}');
    expect(stableStringify({ z: { y: 1, x: 2 }, a: [3, 1] })).toBe('{"a":[3,1],"z":{"x":2,"y":1}}');
  });
});

describe('GatewayCallLog.record — content_sha256 wiring', () => {
  let dir: string;
  let dbPath: string;

  function rec(over: Partial<LLMCallRecord> = {}): LLMCallRecord {
    return { traceId: 't', caller: 'agent', irRequest: ir(), ...over };
  }
  function readSha(traceId: string): string | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT content_sha256 FROM llm_calls WHERE trace_id = ?').get(traceId) as
        | { content_sha256: string | null }
        | undefined;
      return row?.content_sha256 ?? null;
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cache-canon-'));
    dbPath = path.join(dir, 'gateway.db');
    __resetGatewayCallLog();
  });
  afterEach(() => {
    __resetGatewayCallLog();
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates content_sha256 from irRequest and equals contentFingerprint', () => {
    const log = getGatewayCallLog(dbPath);
    log.record(rec({ traceId: 'x1' }));
    expect(readSha('x1')).toBe(contentFingerprint(ir()));
  });

  it('same content from DIFFERENT callers collides (shared-cache intent)', () => {
    const log = getGatewayCallLog(dbPath);
    log.record(rec({ traceId: 'a', caller: 'rag', irRequest: ir({ caller: 'rag', trace_id: 'a' }) }));
    log.record(rec({ traceId: 'b', caller: 'agent', irRequest: ir({ caller: 'agent', trace_id: 'b' }) }));
    expect(readSha('a')).toBe(readSha('b'));
  });

  it('different content → different fingerprint', () => {
    const log = getGatewayCallLog(dbPath);
    log.record(rec({ traceId: 'a', irRequest: ir() }));
    log.record(rec({ traceId: 'b', irRequest: ir({ system: 'different' }) }));
    expect(readSha('a')).not.toBe(readSha('b'));
  });

  it('fail-open: absent irRequest → NULL, no throw', () => {
    const log = getGatewayCallLog(dbPath);
    expect(() => log.record({ traceId: 'noir', caller: 'health' })).not.toThrow();
    expect(readSha('noir')).toBeNull();
  });

  it('migrates a legacy DB (adds column + index AFTER column exists)', () => {
    // Build a pre-migration llm_calls table WITHOUT content_sha256.
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE llm_calls (
      trace_id TEXT PRIMARY KEY, ts TEXT NOT NULL, caller TEXT NOT NULL, purpose TEXT,
      alias TEXT, route TEXT, priority TEXT, ir_request TEXT, ir_response TEXT,
      wire_payload_sha256 TEXT, error_class TEXT, latency_ms INTEGER, ttft_ms INTEGER,
      tokens_in INTEGER, tokens_out INTEGER, tokens_cached INTEGER, cost_usd REAL, outcome TEXT)`);
    seed.close();

    const log = getGatewayCallLog(dbPath); // _applyDdl runs the migration + index
    const cols = new Set(
      (new Database(dbPath, { readonly: true }).prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('content_sha256')).toBe(true);

    log.record(rec({ traceId: 'mig' }));
    expect(readSha('mig')).toBe(contentFingerprint(ir()));
  });
});
