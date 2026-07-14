/**
 * @file tests/brain/gateway-log-wiring.test.ts
 * @description gw-refactor Phase 5: the legacy Brain.call path writes ONE
 * GatewayCallLog row per successful non-streaming call, with cheap summary
 * payloads (never full messages) — and writes nothing when SUDO_GATEWAY_LOG=0.
 *
 * Reuses the context-overflow-shortcircuit harness: vi.mock('ai') so
 * generateText is a stub, real Brain, singleton GatewayCallLog pinned to a
 * temp DB. Under vitest the wiring is dormant unless SUDO_GATEWAY_LOG_TEST=1
 * (the _recordBillingUsage no-test-DB-pollution idiom).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

import { Brain } from '../../src/core/brain/brain.js';
import { getGatewayCallLog, __resetGatewayCallLog } from '../../src/llm/logging.js';

const ENV_KEYS = ['SUDO_GATEWAY_LOG', 'SUDO_GATEWAY_LOG_TEST', 'SUDO_BRAIN_CONSENSUS_DISABLE'] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

interface CallRow {
  trace_id: string;
  caller: string;
  purpose: string | null;
  alias: string | null;
  route: string | null;
  priority: string | null;
  ir_request: string | null;
  ir_response: string | null;
  error_class: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

function allRows(): CallRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM llm_calls').all() as CallRow[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env['SUDO_GATEWAY_LOG_TEST'] = '1'; // opt the wiring in under vitest
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic single-model path
  dir = mkdtempSync(path.join(tmpdir(), 'gwlog-brain-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetGatewayCallLog();
  getGatewayCallLog(dbPath); // pin the singleton BEFORE Brain records
  generateTextMock.mockReset();
});

afterEach(() => {
  __resetGatewayCallLog();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('Brain.call → GatewayCallLog (legacy non-streaming path)', () => {
  it('writes one summary row per successful call', async () => {
    generateTextMock.mockResolvedValue({
      text: 'hello from the model',
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      finishReason: 'stop',
    });
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;

    await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    const rows = allRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.caller).toBe('agent');
    expect(row.purpose).toBe('brain.call');
    expect(row.priority).toBe('user'); // source 'agent' → user-facing
    expect(row.alias).toBeTruthy(); // the resolved modelId
    expect(row.route === 'anthropic:messages' || row.route === 'openai-compat:chat').toBe(true);
    expect(row.error_class).toBeNull();
    expect(row.tokens_in).toBe(12);
    expect(row.tokens_out).toBe(5);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);

    // Legacy path is NOT IR: cheap summary only, never the full messages.
    const irReq = JSON.parse(row.ir_request ?? '{}') as Record<string, unknown>;
    expect(irReq['legacy']).toBe(true);
    expect(irReq['messageCount']).toBe(1);
    expect(typeof irReq['system_chars']).toBe('number');
    expect(row.ir_request).not.toContain('hi'); // no message content persisted
    const irRes = JSON.parse(row.ir_response ?? '{}') as Record<string, unknown>;
    expect(irRes['text_chars']).toBe('hello from the model'.length);
    expect(irRes['finishReason']).toBe('stop');
  });

  it('background source → priority background', async () => {
    generateTextMock.mockResolvedValue({
      text: 'tick',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      finishReason: 'stop',
    });
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    await brain.call({ messages: [{ role: 'user', content: 'ping' }], source: 'consciousness' });
    const rows = allRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.caller).toBe('consciousness');
    expect(rows[0]!.priority).toBe('background');
  });

  it('kill-switch SUDO_GATEWAY_LOG=0 → no row, call unaffected', async () => {
    process.env['SUDO_GATEWAY_LOG'] = '0';
    generateTextMock.mockResolvedValue({
      text: 'still works',
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      finishReason: 'stop',
    });
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('still works');
    expect(allRows().length).toBe(0);
  });
});
