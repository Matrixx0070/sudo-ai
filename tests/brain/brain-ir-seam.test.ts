/**
 * @file tests/brain/brain-ir-seam.test.ts
 * @description gw-cutover Phase 2 — Brain's per-attempt IR-transport seam
 * (LLM_IR_CALLERS). Harness pattern from gateway-log-wiring.test.ts:
 * vi.mock('ai') stubs the legacy generateText wire hop; the IR path runs the
 * REAL callIR against a stubbed global fetch (so the transport's own
 * llm_calls row + noteTraceForSession wiring are exercised end-to-end).
 *
 * Proven here:
 * - byte-equivalence: IR-served brain.call deep-equals the legacy path fed
 *   the equivalent provider response.
 * - transport throw → same-attempt legacy fallback (user-invisible).
 * - exactly ONE llm_calls row for IR-served calls (the transport's, with
 *   caller/priority; brain's own _recordGatewayCall is skipped).
 * - sessionId → noteTraceForSession → markOutcomeForSession lands on the row.
 * - flag-off regression: LLM_IR_CALLERS unset → the transport (fetch) is
 *   never touched and the legacy summary row is written.
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
import { getGatewayCallLog, __resetGatewayCallLog, markOutcomeForSession } from '../../src/llm/logging.js';
import { __resetPolicyState } from '../../src/llm/policy.js';

const ENV_KEYS = [
  'SUDO_GATEWAY_LOG',
  'SUDO_GATEWAY_LOG_TEST',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
  'SUDO_SMART_ROUTE_DISABLE',
  'LLM_IR_CALLERS',
  'XAI_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let dir: string;
let dbPath: string;

/** Deterministic single-model config: profile.id is pinned to the xai route. */
const MODEL = 'xai/grok-4-fast-non-reasoning';
const BRAIN_CONFIG = { models: { primary: [{ id: MODEL, maxOutputTokens: 8192 }] } };

interface CallRow {
  trace_id: string;
  caller: string;
  purpose: string | null;
  priority: string | null;
  ir_request: string | null;
  outcome: string | null;
}

function allRows(): CallRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM llm_calls').all() as CallRow[];
  } finally {
    db.close();
  }
}

/** OpenAI-compat wire response equivalent to the legacy generateText stub. */
const WIRE_RESPONSE = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'hello from the model',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
};

/** The SAME response in the resolved ai-SDK generateText shape. */
const LEGACY_RESPONSE = {
  text: 'hello from the model',
  toolCalls: [{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Oslo' } }],
  usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
  finishReason: 'tool-calls',
};

function stubFetchJson(json: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function newBrain(): Promise<Brain> {
  const brain = new Brain(BRAIN_CONFIG);
  await (brain as unknown as { providersReady: Promise<void> }).providersReady;
  return brain;
}

/** Deterministic slice of a BrainResponse (routing carries latency-ish text). */
function comparable(r: Awaited<ReturnType<Brain['call']>>): unknown {
  return {
    content: r.content,
    toolCalls: r.toolCalls,
    usage: r.usage,
    model: r.model,
    finishReason: r.finishReason,
    sampling: r.sampling,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env['SUDO_GATEWAY_LOG_TEST'] = '1'; // opt the wiring in under vitest
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic single-model path
  process.env['SUDO_SMART_ROUTE_DISABLE'] = '1'; // pin the profile to MODEL (no cheap-route)
  process.env['XAI_API_KEY'] = 'xai-test-key';
  dir = mkdtempSync(path.join(tmpdir(), 'gwlog-brain-ir-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetGatewayCallLog();
  __resetPolicyState();
  getGatewayCallLog(dbPath); // pin the singleton BEFORE Brain/transport record
  generateTextMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetGatewayCallLog();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('Brain.call IR seam (LLM_IR_CALLERS)', () => {
  it('IR-served result is DEEP-EQUAL to the legacy path fed the equivalent provider response', async () => {
    // --- IR path: real callIR against a stubbed fetch -----------------------
    process.env['LLM_IR_CALLERS'] = '*';
    const fetchSpy = stubFetchJson(WIRE_RESPONSE);
    const irBrain = await newBrain();
    const irRes = await irBrain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled(); // legacy wire hop skipped

    // --- legacy path: flag off, equivalent generateText resolution ----------
    delete process.env['LLM_IR_CALLERS'];
    __resetPolicyState();
    generateTextMock.mockResolvedValue(LEGACY_RESPONSE);
    const legacyBrain = await newBrain();
    const legacyRes = await legacyBrain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    expect(comparable(irRes)).toEqual(comparable(legacyRes));
    // Spot-check the substance so an accidentally-empty deep-equal can't pass.
    expect(irRes.content).toBe('hello from the model');
    expect(irRes.finishReason).toBe('tool-calls');
    expect(irRes.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } }]);
    expect(irRes.usage.promptTokens).toBe(12);
    expect(irRes.usage.completionTokens).toBe(5);
  });

  it('IR-served call writes exactly ONE llm_calls row — the transport’s, with caller + priority', async () => {
    process.env['LLM_IR_CALLERS'] = '*';
    stubFetchJson(WIRE_RESPONSE);
    const brain = await newBrain();
    await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    const rows = allRows();
    expect(rows.length).toBe(1); // brain's own _recordGatewayCall was skipped
    expect(rows[0]!.caller).toBe('agent');
    expect(rows[0]!.purpose).toBe('brain.call');
    expect(rows[0]!.priority).toBe('user'); // source 'agent' → user (same rule as brain)
    // The transport row is FULL IR, not brain's {legacy:true} summary.
    const irReq = JSON.parse(rows[0]!.ir_request ?? '{}') as Record<string, unknown>;
    expect(irReq['legacy']).toBeUndefined();
    expect(irReq['alias']).toBe(MODEL);
  });

  it('sessionId → noteTraceForSession: markOutcomeForSession stamps the transport row', async () => {
    process.env['LLM_IR_CALLERS'] = '*';
    stubFetchJson(WIRE_RESPONSE);
    const brain = await newBrain();
    await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent', sessionId: 'sess-ir-1' });

    markOutcomeForSession('sess-ir-1', 'accepted');
    const rows = allRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe('accepted');
  });

  it('transport throw → warn + same-attempt legacy fallback (result still returned)', async () => {
    process.env['LLM_IR_CALLERS'] = '*';
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    generateTextMock.mockResolvedValue(LEGACY_RESPONSE);

    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // ONE transport attempt (noRetry), then fallback
    expect(generateTextMock).toHaveBeenCalledTimes(1); // legacy path served the same attempt
    expect(res.content).toBe('hello from the model');
    // Fallback attempt is NOT IR-served → brain wrote its legacy summary row
    // (plus the transport's failure row: two rows for two real wire events).
    const purposes = allRows().map((r) => ({ purpose: r.purpose, legacy: (JSON.parse(r.ir_request ?? '{}') as Record<string, unknown>)['legacy'] }));
    expect(purposes.filter((p) => p.legacy === true)).toHaveLength(1);
  });

  it('flag OFF (unset) → transport never invoked; legacy summary row written', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('transport must not be touched when LLM_IR_CALLERS is unset');
    });
    vi.stubGlobal('fetch', fetchSpy);
    generateTextMock.mockResolvedValue(LEGACY_RESPONSE);

    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content).toBe('hello from the model');
    const rows = allRows();
    expect(rows.length).toBe(1);
    const irReq = JSON.parse(rows[0]!.ir_request ?? '{}') as Record<string, unknown>;
    expect(irReq['legacy']).toBe(true); // byte-identical legacy behavior
  });

  it('flag set but source NOT in the list → legacy path', async () => {
    process.env['LLM_IR_CALLERS'] = 'health,consciousness';
    const fetchSpy = vi.fn(async () => {
      throw new Error('transport must not be touched for unlisted sources');
    });
    vi.stubGlobal('fetch', fetchSpy);
    generateTextMock.mockResolvedValue(LEGACY_RESPONSE);

    const brain = await newBrain();
    await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F3: cancelled IR streams still bill their partial usage
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function stubFetchSSE(chunks: string[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
        else controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('Brain.stream IR seam — cancelled-stream billing (F3)', () => {
  it('early break → _recordBillingUsage called with the LAST-KNOWN partial usage', async () => {
    process.env['LLM_IR_CALLERS'] = '*';
    // Usage rides the first chunk so the machine holds a partial snapshot
    // when the consumer walks away (OpenAI include_usage may attach anywhere).
    stubFetchSSE([
      sseChunk({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }], usage: { prompt_tokens: 30, completion_tokens: 2 } }),
      sseChunk({ choices: [{ delta: { content: 'lo.' } }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    const brain = await newBrain();
    const billSpy = vi
      .spyOn(brain as unknown as { _recordBillingUsage: (...a: unknown[]) => void }, '_recordBillingUsage')
      .mockImplementation(() => {});

    const chunks: string[] = [];
    for await (const chunk of brain.stream({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' })) {
      chunks.push(chunk);
      break; // consumer walks away mid-stream
    }
    expect(chunks).toEqual(['Hel']);

    // Billing is fire-and-forget from the finally — flush the microtasks.
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setImmediate(r));

    expect(billSpy).toHaveBeenCalledTimes(1);
    const [model, usage, cacheTokens, , isStream, source] = billSpy.mock.calls[0]! as [
      string,
      { promptTokens: number; completionTokens: number } | undefined,
      { create: number; read: number },
      number,
      boolean,
      string,
    ];
    expect(model).toBe(MODEL);
    expect(usage?.promptTokens).toBe(30); // the PARTIAL usage, not zeros/undefined
    expect(usage?.completionTokens).toBe(2);
    expect(cacheTokens).toEqual({ create: 0, read: 0 });
    expect(isStream).toBe(true);
    expect(source).toBe('agent');
  });

  it('full consumption bills exactly ONCE (no double-billing from the finally)', async () => {
    process.env['LLM_IR_CALLERS'] = '*';
    stubFetchSSE([
      sseChunk({ choices: [{ delta: { role: 'assistant', content: 'Hello.' } }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseChunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      'data: [DONE]\n\n',
    ]);
    const brain = await newBrain();
    const billSpy = vi
      .spyOn(brain as unknown as { _recordBillingUsage: (...a: unknown[]) => void }, '_recordBillingUsage')
      .mockImplementation(() => {});

    let text = '';
    for await (const chunk of brain.stream({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' })) {
      text += chunk;
    }
    expect(text).toBe('Hello.');

    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setImmediate(r));

    expect(billSpy).toHaveBeenCalledTimes(1);
    const usage = billSpy.mock.calls[0]![1] as { promptTokens: number; completionTokens: number };
    expect(usage.promptTokens).toBe(12);
    expect(usage.completionTokens).toBe(4);
  });
});
