/**
 * @file tests/learning/trace-store-capture.test.ts
 * @description Opt-in replay capture (SUDO_TRACE_CAPTURE=1): traces gain raw
 * args/result/prompt/response + model params (size-capped) so a run becomes
 * replay-capable, instead of storing only hashes. Also covers the additive
 * migration that adds the columns to a pre-existing traces.db.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import {
  TraceStore,
  capCaptured,
  isTraceCaptureEnabled,
} from '../../src/core/learning/trace-store.js';

let tmpDir: string;
let dbPath: string;
let savedFlag: string | undefined;
let savedMax: string | undefined;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `sudo-trace-cap-${Date.now()}-${Math.floor(performance.now())}`);
  mkdirSync(tmpDir, { recursive: true });
  dbPath = path.join(tmpDir, 'traces.db');
  savedFlag = process.env['SUDO_TRACE_CAPTURE'];
  savedMax = process.env['SUDO_TRACE_CAPTURE_MAX_BYTES'];
  delete process.env['SUDO_TRACE_CAPTURE'];
  delete process.env['SUDO_TRACE_CAPTURE_MAX_BYTES'];
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env['SUDO_TRACE_CAPTURE']; else process.env['SUDO_TRACE_CAPTURE'] = savedFlag;
  if (savedMax === undefined) delete process.env['SUDO_TRACE_CAPTURE_MAX_BYTES']; else process.env['SUDO_TRACE_CAPTURE_MAX_BYTES'] = savedMax;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TraceStore replay capture (opt-in)', () => {
  it('CAP-1: capture OFF (default) keeps hashes but no raw payloads', async () => {
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'x' }, { success: false, output: 'no rows' });
    const [t] = store.query({ sessionId: 's1' });
    expect(t.resultHash).toBeTruthy();      // hash always kept
    expect(t.resultRaw).toBeUndefined();    // raw NOT captured
    expect(t.argsRaw).toBeUndefined();
    store.close();
  });

  it('CAP-2: capture ON stores raw args + result', async () => {
    process.env['SUDO_TRACE_CAPTURE'] = '1';
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'hello' }, { success: false, output: 'no rows' });
    const [t] = store.query({ sessionId: 's1' });
    expect(t.argsRaw).toBe(JSON.stringify({ q: 'hello' }));
    expect(t.resultRaw).toBe(JSON.stringify({ success: false, output: 'no rows' }));
    store.close();
  });

  it('CAP-3: captured fields are size-capped with an annotation', async () => {
    process.env['SUDO_TRACE_CAPTURE'] = '1';
    process.env['SUDO_TRACE_CAPTURE_MAX_BYTES'] = '20';
    const store = new TraceStore(dbPath);
    await store.init();
    const big = 'A'.repeat(500);
    store.recordToolCall('s1', 'scrape', true, 5, undefined, undefined, big);
    const [t] = store.query({ sessionId: 's1' });
    expect(t.resultRaw!.startsWith('AAAAAAAAAAAAAAAAAAAA')).toBe(true); // first 20
    expect(t.resultRaw).toContain('truncated');
    expect(t.resultRaw!.length).toBeLessThan(big.length);
    store.close();
  });

  it('CAP-B1: brain-call capture OFF (default) keeps only fact-of-call', async () => {
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordBrainCall('s1', 'anthropic/claude', true, 0, undefined, undefined, {
      prompt: [{ role: 'user', content: 'hi' }],
      response: { content: 'hello', toolCalls: [] },
      modelParams: { temperature: 0.5, maxTokens: 4096 },
    });
    const [t] = store.query({ sessionId: 's1', type: 'brain_call' });
    expect(t.promptRaw).toBeUndefined();   // flag off -> no raw payloads
    expect(t.responseRaw).toBeUndefined();
    expect(t.modelParams).toBeUndefined();
    store.close();
  });

  it('CAP-B2: brain-call capture ON stores prompt, response, and model params', async () => {
    process.env['SUDO_TRACE_CAPTURE'] = '1';
    const store = new TraceStore(dbPath);
    await store.init();
    const prompt = [{ role: 'user', content: 'what is 2+2?' }];
    const response = { content: '4', toolCalls: [] };
    const modelParams = { model: 'anthropic/claude', source: 'agent', temperature: 0.5, maxTokens: 4096 };
    store.recordBrainCall('s1', 'anthropic/claude', true, 0, undefined, undefined, { prompt, response, modelParams });
    const [t] = store.query({ sessionId: 's1', type: 'brain_call' });
    expect(t.promptRaw).toBe(JSON.stringify(prompt));
    expect(t.responseRaw).toBe(JSON.stringify(response));
    expect(t.modelParams).toBe(JSON.stringify(modelParams));
    store.close();
  });

  it('CAP-B3: brain-call capture ON but no capture arg keeps fact-of-call only', async () => {
    process.env['SUDO_TRACE_CAPTURE'] = '1';
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordBrainCall('s1', 'anthropic/claude', true, 0); // legacy call shape
    const [t] = store.query({ sessionId: 's1', type: 'brain_call' });
    expect(t.promptRaw).toBeUndefined();
    expect(t.modelParams).toBeUndefined();
    expect(t.model).toBe('anthropic/claude'); // still recorded
    store.close();
  });

  it('CAP-4: additive migration adds columns to a pre-existing traces.db', async () => {
    // Seed an OLD-schema traces table (no capture columns).
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trace_type TEXT NOT NULL, session_id TEXT,
      model TEXT, tool_name TEXT, intent TEXT, category TEXT, success INTEGER NOT NULL,
      error_type TEXT, error_message TEXT, latency_ms INTEGER, token_usage TEXT,
      routing_tier TEXT, routing_confidence REAL, args_hash TEXT, result_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')) );`);
    seed.close();

    process.env['SUDO_TRACE_CAPTURE'] = '1';
    const store = new TraceStore(dbPath);
    await store.init(); // must ALTER TABLE ADD COLUMN without throwing
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'x' }, 'result text');
    const [t] = store.query({ sessionId: 's1' });
    expect(t.resultRaw).toBe('result text'); // capture works on the migrated table
    store.close();
  });
});

describe('capture helpers', () => {
  it('HELP-1: isTraceCaptureEnabled requires exact "1"', () => {
    delete process.env['SUDO_TRACE_CAPTURE'];
    expect(isTraceCaptureEnabled()).toBe(false);
    process.env['SUDO_TRACE_CAPTURE'] = 'true';
    expect(isTraceCaptureEnabled()).toBe(false);
    process.env['SUDO_TRACE_CAPTURE'] = '1';
    expect(isTraceCaptureEnabled()).toBe(true);
  });

  it('HELP-2: capCaptured passes short strings through and truncates long ones', () => {
    process.env['SUDO_TRACE_CAPTURE_MAX_BYTES'] = '10';
    expect(capCaptured('short')).toBe('short');
    expect(capCaptured(undefined)).toBeUndefined();
    expect(capCaptured(null)).toBeUndefined();
    const out = capCaptured('X'.repeat(50));
    expect(out!.startsWith('XXXXXXXXXX')).toBe(true);
    expect(out).toContain('truncated');
  });
});
