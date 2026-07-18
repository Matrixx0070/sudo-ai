/**
 * @file tests/brain/gateway-log-wiring.test.ts
 * @description F97 cutover — Brain writes NO GatewayCallLog row on a successful
 * call: the IR transport owns the ONE llm_calls row per wire call. With the
 * bridge mocked here, a successful brain.call must therefore add ZERO rows.
 *
 * The one summary row brain still owns is the TERMINAL-failure row for a fully
 * exhausted failover sequence (per-attempt errors are failover-internal) —
 * pinned here, along with its SUDO_GATEWAY_LOG=0 kill-switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const callTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: vi.fn(),
}));

import { Brain } from '../../src/core/brain/brain.js';
import { getGatewayCallLog, __resetGatewayCallLog } from '../../src/llm/logging.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const ENV_KEYS = [
  'SUDO_GATEWAY_LOG',
  'SUDO_GATEWAY_LOG_TEST',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
  'SUDO_FAILOVER_BACKOFF_DISABLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

interface CallRow {
  trace_id: string;
  caller: string;
  purpose: string | null;
  ir_request: string | null;
  error_class: string | null;
  latency_ms: number | null;
}

function allRows(): CallRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM llm_calls').all() as CallRow[];
  } finally {
    db.close();
  }
}

function okCall(text: string) {
  return {
    result: {
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
      reasoning: undefined,
      reasoningText: undefined,
      providerMetadata: undefined,
    },
    traceId: 'trace-gwlog',
  };
}

function profile(id: string): ModelProfile {
  return {
    id,
    provider: id.slice(0, id.indexOf('/')),
    modelId: id.slice(id.indexOf('/') + 1),
    priority: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env['SUDO_GATEWAY_LOG_TEST'] = '1'; // opt the wiring in under vitest
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic single-model path
  process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] = '1'; // no real sleeps between attempts
  dir = mkdtempSync(path.join(tmpdir(), 'gwlog-brain-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetGatewayCallLog();
  getGatewayCallLog(dbPath); // pin the singleton BEFORE Brain records
  callTransportMock.mockReset();
});

afterEach(() => {
  __resetGatewayCallLog();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('Brain.call → GatewayCallLog (F97: transport owns the success row)', () => {
  it('successful IR-served call writes ZERO rows from brain (bridge mocked → no row appears at all)', async () => {
    callTransportMock.mockResolvedValue(okCall('hello from the model'));
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });
    expect(res.content).toBe('hello from the model');
    // The real transport would have written its own llm_calls row; brain adds
    // NONE on success. With the bridge mocked, the table must stay empty.
    expect(allRows()).toHaveLength(0);
  });

  it('background source: still zero rows on success (no priority row from brain either)', async () => {
    callTransportMock.mockResolvedValue(okCall('tick'));
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    await brain.call({ messages: [{ role: 'user', content: 'ping' }], source: 'consciousness' });
    expect(allRows()).toHaveLength(0);
  });

  it('fully exhausted failover → brain writes its ONE terminal-failure summary row', async () => {
    callTransportMock.mockRejectedValue(Object.assign(new Error('status 429'), { statusCode: 429 }));
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    // Keep the pool non-empty so the loop runs its full MAX_FAILOVER_ATTEMPTS
    // and reaches the terminal-row block (cooldowns would otherwise empty it).
    (brain as any).failover.getNextProfile = () => profile('xai/grok-test');

    await expect(
      brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' }),
    ).rejects.toThrow('All failover attempts failed');

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caller).toBe('agent');
    expect(rows[0]!.purpose).toBe('brain.call');
    expect(rows[0]!.error_class).toBeTruthy();
    // Cheap summary only, never the full messages.
    const irReq = JSON.parse(rows[0]!.ir_request ?? '{}') as Record<string, unknown>;
    expect(irReq['legacy']).toBe(true);
    expect(irReq['messageCount']).toBe(1);
    expect(rows[0]!.ir_request).not.toContain('hi');
  });

  it('kill-switch SUDO_GATEWAY_LOG=0 → no terminal row either, call failure unaffected', async () => {
    process.env['SUDO_GATEWAY_LOG'] = '0';
    callTransportMock.mockRejectedValue(Object.assign(new Error('status 429'), { statusCode: 429 }));
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;
    (brain as any).failover.getNextProfile = () => profile('xai/grok-test');

    await expect(
      brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' }),
    ).rejects.toThrow('All failover attempts failed');
    expect(allRows()).toHaveLength(0);
  });
});
