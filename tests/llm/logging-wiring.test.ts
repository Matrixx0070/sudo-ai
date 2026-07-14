/**
 * @file tests/llm/logging-wiring.test.ts
 * @description gw-refactor Phase 5 wiring units: session→trace correlation
 * (noteTraceForSession / markOutcomeForSession round-trip, bounded LRU cap,
 * kill-switch) and the user-rephrase jaccard heuristic. The brain.ts /
 * client.ts call-site wiring itself is covered by
 * tests/brain/gateway-log-wiring.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getGatewayCallLog,
  __resetGatewayCallLog,
  __resetSessionTraces,
  noteTraceForSession,
  markOutcomeForSession,
  isLikelyRephrase,
  jaccardWordSimilarity,
} from '../../src/llm/logging.js';

const ENV_KEYS = ['SUDO_GATEWAY_LOG'] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

function outcomeOf(traceId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT outcome FROM llm_calls WHERE trace_id = ?').get(traceId) as
      | { outcome: string | null }
      | undefined;
    return row?.outcome ?? null;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(path.join(tmpdir(), 'gwlog-wiring-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetGatewayCallLog();
  __resetSessionTraces();
  getGatewayCallLog(dbPath); // pin the singleton to the temp DB
});

afterEach(() => {
  __resetGatewayCallLog();
  __resetSessionTraces();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('session→trace correlation', () => {
  it('round-trip: noteTraceForSession then markOutcomeForSession stamps the row', () => {
    getGatewayCallLog().record({ traceId: 't-1', caller: 'test' });
    noteTraceForSession('sess-a', 't-1');
    markOutcomeForSession('sess-a', 'escalation_fired');
    expect(outcomeOf('t-1')).toBe('escalation_fired');
  });

  it('uses the LAST trace noted for the session', () => {
    getGatewayCallLog().record({ traceId: 't-old', caller: 'test' });
    getGatewayCallLog().record({ traceId: 't-new', caller: 'test' });
    noteTraceForSession('sess-a', 't-old');
    noteTraceForSession('sess-a', 't-new');
    markOutcomeForSession('sess-a', 'verifier_rejected');
    expect(outcomeOf('t-old')).toBeNull();
    expect(outcomeOf('t-new')).toBe('verifier_rejected');
  });

  it('no-op (never throws) when the session has no noted trace', () => {
    getGatewayCallLog().record({ traceId: 't-1', caller: 'test' });
    expect(() => markOutcomeForSession('never-seen', 'user_rephrased')).not.toThrow();
    expect(outcomeOf('t-1')).toBeNull();
  });

  it('LRU cap: oldest-noted session is evicted past 500 entries', () => {
    getGatewayCallLog().record({ traceId: 't-first', caller: 'test' });
    getGatewayCallLog().record({ traceId: 't-last', caller: 'test' });
    noteTraceForSession('sess-0', 't-first');
    for (let i = 1; i <= 500; i++) noteTraceForSession(`sess-${i}`, i === 500 ? 't-last' : `t-${i}`);
    // sess-0 was the oldest of 501 → evicted; stamping it is a no-op.
    markOutcomeForSession('sess-0', 'escalation_fired');
    expect(outcomeOf('t-first')).toBeNull();
    // The newest session still resolves.
    markOutcomeForSession('sess-500', 'escalation_fired');
    expect(outcomeOf('t-last')).toBe('escalation_fired');
  });

  it('re-noting a session refreshes its recency (LRU, not FIFO)', () => {
    getGatewayCallLog().record({ traceId: 't-a', caller: 'test' });
    noteTraceForSession('sess-a', 't-a');
    for (let i = 1; i <= 499; i++) noteTraceForSession(`sess-${i}`, `t-${i}`); // map now at cap (500)
    noteTraceForSession('sess-a', 't-a'); // refresh — sess-a becomes newest
    noteTraceForSession('sess-overflow', 't-x'); // evicts sess-1, NOT sess-a
    markOutcomeForSession('sess-a', 'user_rephrased');
    expect(outcomeOf('t-a')).toBe('user_rephrased');
  });

  it('kill-switch SUDO_GATEWAY_LOG=0 disables noting and stamping', () => {
    getGatewayCallLog().record({ traceId: 't-1', caller: 'test' });
    process.env['SUDO_GATEWAY_LOG'] = '0';
    noteTraceForSession('sess-a', 't-1');
    markOutcomeForSession('sess-a', 'escalation_fired');
    delete process.env['SUDO_GATEWAY_LOG'];
    // Nothing was noted while disabled → stamping later is still a no-op.
    markOutcomeForSession('sess-a', 'escalation_fired');
    expect(outcomeOf('t-1')).toBeNull();
  });
});

describe('user-rephrase heuristic', () => {
  it('detects a rephrase of the same ask (word-set jaccard > 0.6)', () => {
    const prev = 'can you list all the files in the src directory';
    const next = 'please list all the files in the src directory now';
    expect(jaccardWordSimilarity(prev, next)).toBeGreaterThan(0.6);
    expect(isLikelyRephrase(prev, next)).toBe(true);
  });

  it('an identical resend counts as a rephrase', () => {
    const msg = 'why is the deploy failing on the gateway step';
    expect(isLikelyRephrase(msg, msg)).toBe(true);
  });

  it('a distinct follow-up question is NOT a rephrase', () => {
    expect(
      isLikelyRephrase(
        'can you list all files in the src directory',
        'what is the weather in berlin today',
      ),
    ).toBe(false);
  });

  it('short strings are ignored (length guard > 10 chars)', () => {
    expect(isLikelyRephrase('ok', 'ok')).toBe(false);
    expect(isLikelyRephrase('hi there', 'hi there')).toBe(false);
    expect(isLikelyRephrase('   padded    ', '   padded    ')).toBe(false); // trimmed length ≤ 10
  });

  it('is case-insensitive and punctuation-tolerant', () => {
    expect(
      isLikelyRephrase('Fix the login bug, please!', 'fix the login bug please??'),
    ).toBe(true);
  });

  it('jaccardWordSimilarity handles empty/wordless inputs without throwing', () => {
    expect(jaccardWordSimilarity('', '')).toBe(0);
    expect(jaccardWordSimilarity('!!! ???', 'hello world')).toBe(0);
  });
});
