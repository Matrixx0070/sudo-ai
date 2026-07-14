/**
 * @file tests/llm/transport-stream.test.ts
 * @description Unit tests for the streaming IR transport (gw-cutover Phase 1).
 * All network is a mocked fetchImpl returning ReadableStreams of scripted SSE
 * bytes — NO real provider calls, NO sockets. The claude-oauth manager module
 * is vi.mock'd exactly as in transport.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IRRequest } from '../../shared-types/ir/v1.js';
import { streamIR } from '../../src/llm/transport.js';
import type { IRStreamEvent } from '../../src/llm/adapters/stream.js';
import { LLMPolicyError } from '../../src/llm/errors.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { sha256Hex, __resetGatewayCallLog, getGatewayCallLog } from '../../src/llm/logging.js';

// ---------------------------------------------------------------------------
// claude-oauth manager mock — same accessor shape as transport.test.ts.
// ---------------------------------------------------------------------------

const oauthMock = {
  getAccessToken: vi.fn<() => string | null>(() => 'oauth-test-token'),
  refreshToken: vi.fn(async () => true),
  isAvailable: vi.fn(() => true),
};

vi.mock('../../src/llm/legacy/claude-oauth-manager.js', () => ({
  getClaudeOAuthManager: () => oauthMock,
}));

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'xai/grok-4-fast-non-reasoning',
    caller: 'test',
    purpose: 'transport-stream-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-stream-1',
    max_tokens: 128,
    ...partial,
  };
}

const enc = new TextEncoder();

/** ReadableStream that enqueues each chunk string then closes. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

/** ReadableStream that emits the chunks then ERRORS (mid-stream failure). */
function sseStreamThenError(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.error(error);
    },
  });
}

/** One OpenAI SSE data frame. */
function oai(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** One Anthropic SSE frame (event: line + data: line, real wire shape). */
function ant(obj: { type: string } & Record<string, unknown>): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | undefined;
}

/**
 * fetchImpl stub: each reply is either a non-2xx JSON response or an SSE
 * body-stream factory (fresh stream per call — retries need a new body).
 */
type Reply =
  | { status: number; json: unknown }
  | { status?: 200; stream: () => ReadableStream<Uint8Array> };

function mockFetch(replies: Reply[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      headers,
      body: String(init?.body),
      signal: init?.signal ?? undefined,
    });
    if ('json' in reply) {
      return new Response(JSON.stringify(reply.json), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(reply.stream(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function collect(it: AsyncIterable<IRStreamEvent>): Promise<IRStreamEvent[]> {
  const out: IRStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const noSleep = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Scripted sessions
// ---------------------------------------------------------------------------

const OPENAI_CHUNKS = [
  oai({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }),
  oai({ choices: [{ delta: { content: 'lo.' } }] }),
  oai({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } },
    ],
  }),
  oai({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } }] }),
  oai({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  // Trailing-usage chunk AFTER finish_reason (stream_options.include_usage).
  oai({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 10 } } }),
  'data: [DONE]\n\n',
];

const ANTHROPIC_CHUNKS = [
  ant({ type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, output_tokens: 1 } } }),
  ant({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ant({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
  ant({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo.' } }),
  ant({ type: 'content_block_stop', index: 0 }),
  ant({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} } }),
  ant({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
  ant({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Oslo"}' } }),
  ant({ type: 'content_block_stop', index: 1 }),
  ant({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } }),
  ant({ type: 'message_stop' }),
];

// ---------------------------------------------------------------------------
// Env scoping (mirrors transport.test.ts)
// ---------------------------------------------------------------------------

const ENV_KEYS = ['XAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUDO_LLM_RETRY_DISABLE', 'SUDO_GATEWAY_LOG_TEST'] as const;
let envBackup: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['XAI_API_KEY'] = 'xai-test-key';
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
  delete process.env['SUDO_LLM_RETRY_DISABLE'];
  __resetPolicyState();
  oauthMock.getAccessToken.mockClear();
  oauthMock.refreshToken.mockClear();
  // Every test asserts the llm_calls row → temp DB per test.
  dir = mkdtempSync(join(tmpdir(), 'transport-stream-'));
  process.env['SUDO_GATEWAY_LOG_TEST'] = '1';
  __resetGatewayCallLog();
  getGatewayCallLog(join(dir, 'gateway.db'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  __resetGatewayCallLog();
  rmSync(dir, { recursive: true, force: true });
});

function readRow(traceId: string): Record<string, unknown> {
  const db = new Database(join(dir, 'gateway.db'), { readonly: true });
  const row = db.prepare('SELECT * FROM llm_calls WHERE trace_id = ?').get(traceId) as Record<string, unknown>;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get() as { n: number }).n;
  db.close();
  expect(count, 'exactly ONE llm_calls row per streamIR call').toBe(1);
  return row;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('streamIR — happy path', () => {
  it('openai family: deltas accumulate, tool args parse, [DONE]+trailing-usage handled, row has ttft/latency', async () => {
    const { fetchImpl, calls } = mockFetch([{ stream: () => sseStream(OPENAI_CHUNKS) }]);
    const events = await collect(streamIR(baseIR(), { fetchImpl }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['stream']).toBe(true); // the ONLY body difference vs callIR
    expect(body['model']).toBe('grok-4-fast-non-reasoning');

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo.' },
      { type: 'tool_use_start', id: 'call_1', name: 'get_weather' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: '{"city":' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: '"Oslo"}' },
      { type: 'tool_use_end', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 25, out: 17, cached_in: 10 } },
    ]);

    const row = readRow('trace-stream-1');
    expect(row['route']).toBe('xai:chat');
    expect(row['error_class']).toBeNull();
    expect(row['tokens_in']).toBe(25);
    expect(row['tokens_out']).toBe(17);
    expect(row['tokens_cached']).toBe(10);
    expect(typeof row['ttft_ms']).toBe('number');
    expect(typeof row['latency_ms']).toBe('number');
    expect(row['wire_payload_sha256']).toBe(sha256Hex(calls[0]!.body));
    const irRes = JSON.parse(row['ir_response'] as string) as { blocks: unknown[]; stop_reason: string };
    expect(irRes.stop_reason).toBe('tool_use');
    expect(irRes.blocks).toEqual([
      { type: 'text', text: 'Hello.' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
  });

  it('anthropic family: message_stop terminates via the machine, usage from message_start+message_delta', async () => {
    const { fetchImpl, calls } = mockFetch([{ stream: () => sseStream(ANTHROPIC_CHUNKS) }]);
    const events = await collect(streamIR(baseIR({ alias: 'anthropic/claude-opus-4-8' }), { fetchImpl }));

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['stream']).toBe(true);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo.' },
      { type: 'tool_use_start', id: 'tu_1', name: 'get_weather' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: '{"city":' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: '"Oslo"}' },
      { type: 'tool_use_end', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 25, out: 17, cached_in: 10 } },
    ]);

    const row = readRow('trace-stream-1');
    expect(row['route']).toBe('anthropic:messages');
    expect(row['error_class']).toBeNull();
    expect(row['tokens_in']).toBe(25);
    expect(row['tokens_out']).toBe(17);
    expect(typeof row['ttft_ms']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// SSE framing edges
// ---------------------------------------------------------------------------

describe('streamIR — SSE framing', () => {
  it('reassembles events split across chunk boundaries and ignores keepalive comments', async () => {
    const full = [
      ': keepalive\n\n',
      ...ANTHROPIC_CHUNKS.slice(0, 5),
      ': another comment mid-stream\n\n',
      ...ANTHROPIC_CHUNKS.slice(5),
    ].join('');
    // Split at hostile byte boundaries (7-byte chunks cut mid-line, mid-JSON).
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));

    const { fetchImpl } = mockFetch([{ stream: () => sseStream(chunks) }]);
    const events = await collect(streamIR(baseIR({ alias: 'anthropic/claude-opus-4-8' }), { fetchImpl }));

    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'text_delta',
      'tool_use_start',
      'tool_input_delta',
      'tool_input_delta',
      'tool_use_end',
      'message_end',
    ]);
    expect(events.at(-1)).toEqual({
      type: 'message_end',
      stop_reason: 'tool_use',
      usage: { in: 25, out: 17, cached_in: 10 },
    });
  });

  it('handles CRLF line endings and \\r\\n split across a chunk boundary', async () => {
    const frame1 = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r';
    const frame2 = '\ndata: [DONE]\r\n\r\n';
    const { fetchImpl } = mockFetch([{ stream: () => sseStream([frame1, frame2]) }]);
    const events = await collect(streamIR(baseIR(), { fetchImpl }));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'message_end', stop_reason: 'end_turn', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(readRow('trace-stream-1')['error_class']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('streamIR — truncation', () => {
  it('openai: stream ends mid tool-args without [DONE] → terminal flush + error_class provider_bug', async () => {
    const { fetchImpl } = mockFetch([{ stream: () => sseStream(OPENAI_CHUNKS.slice(0, 4)) }]);
    const events = await collect(streamIR(baseIR(), { fetchImpl }));

    // Machine contract: pending tool flushed (parsed once), then message_end.
    expect(events.at(-2)).toEqual({
      type: 'tool_use_end',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'Oslo' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'message_end', stop_reason: 'end_turn' });

    const row = readRow('trace-stream-1');
    expect(row['error_class']).toBe('provider_bug');
    expect(typeof row['ttft_ms']).toBe('number');
  });

  it('anthropic: stream ends mid input_json_delta → terminal flush per machine contract + error_class', async () => {
    const { fetchImpl } = mockFetch([{ stream: () => sseStream(ANTHROPIC_CHUNKS.slice(0, 7)) }]);
    const events = await collect(streamIR(baseIR({ alias: 'anthropic/claude-opus-4-8' }), { fetchImpl }));

    expect(events.at(-1)).toMatchObject({ type: 'message_end' });
    expect(readRow('trace-stream-1')['error_class']).toBe('provider_bug');
  });
});

// ---------------------------------------------------------------------------
// RULE 4 — retry discipline
// ---------------------------------------------------------------------------

describe('streamIR — RULE 4', () => {
  it('abort after first token: stream_error + terminal message_end error, fetch called EXACTLY once', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        stream: () =>
          sseStreamThenError([oai({ choices: [{ delta: { content: 'partial an' } }] })], new Error('socket reset')),
      },
    ]);
    // Retries are ENABLED (no SUDO_LLM_RETRY_DISABLE) — must still be 1 fetch.
    const events = await collect(streamIR(baseIR(), { fetchImpl, sleep: noSleep, rng: () => 0.5 }));

    expect(events).toEqual([
      { type: 'text_delta', text: 'partial an' },
      { type: 'stream_error', error: 'socket reset' },
      { type: 'message_end', stop_reason: 'error', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(calls).toHaveLength(1); // NEVER re-request after first token

    const row = readRow('trace-stream-1');
    expect(typeof row['error_class']).toBe('string'); // classified from the failure
    const irRes = JSON.parse(row['ir_response'] as string) as { stop_reason: string };
    expect(irRes.stop_reason).toBe('error');
  });

  it('retry before first token: 529 overloaded then success → events flow, fetch called twice', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 529, json: { error: { type: 'overloaded_error', message: 'Overloaded' } } },
      { stream: () => sseStream(OPENAI_CHUNKS) },
    ]);
    const events = await collect(streamIR(baseIR(), { fetchImpl, sleep: noSleep, rng: () => 0.5 }));

    expect(calls).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(events.at(-1)).toMatchObject({ type: 'message_end', stop_reason: 'tool_use' });
    expect(readRow('trace-stream-1')['error_class']).toBeNull();
  });

  it('all retries exhausted pre-first-token: throws AND writes one row with error_class', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 529, json: { error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]);
    const err = await collect(streamIR(baseIR(), { fetchImpl, sleep: noSleep, rng: () => 0.5 })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('overloaded');
    expect(calls).toHaveLength(3); // MAX_ATTEMPTS
    expect(readRow('trace-stream-1')['error_class']).toBe('overloaded');
  });
});

// ---------------------------------------------------------------------------
// Consumer cancellation
// ---------------------------------------------------------------------------

describe('streamIR — consumer break', () => {
  it('breaking out of iteration aborts the fetch signal and still writes the row', async () => {
    const { fetchImpl, calls } = mockFetch([{ stream: () => sseStream(OPENAI_CHUNKS) }]);

    const seen: IRStreamEvent[] = [];
    for await (const ev of streamIR(baseIR(), { fetchImpl })) {
      seen.push(ev);
      if (seen.length === 1) break; // consumer walks away mid-stream
    }

    expect(seen).toEqual([{ type: 'text_delta', text: 'Hel' }]);
    expect(calls[0]!.signal?.aborted).toBe(true); // underlying fetch aborted

    const row = readRow('trace-stream-1');
    expect(typeof row['latency_ms']).toBe('number');
    const irRes = JSON.parse(row['ir_response'] as string) as { stop_reason: string; blocks: unknown[] };
    expect(irRes.stop_reason).toBe('error'); // partial — never invent success
    expect(irRes.blocks).toEqual([{ type: 'text', text: 'Hel' }]);
    // No unhandled rejection: vitest fails the test run on any, and the
    // event loop settles here before the assertion.
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// claude-oauth streaming
// ---------------------------------------------------------------------------

describe('streamIR — claude-oauth', () => {
  it('sends oauth headers + attestation + stream:true; reverses sanitized tool names on yielded events', async () => {
    const chunks = [
      ant({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      ant({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__connect', input: {} } }),
      ant({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://x"}' } }),
      ant({ type: 'content_block_stop', index: 0 }),
      ant({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
      ant({ type: 'message_stop' }),
    ];
    const { fetchImpl, calls } = mockFetch([{ stream: () => sseStream(chunks) }]);
    const events = await collect(
      streamIR(
        baseIR({
          alias: 'claude-oauth/claude-opus-4-8',
          tools: [{ name: 'mcp.connect', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }],
        }),
        { fetchImpl },
      ),
    );

    expect(calls[0]!.headers['authorization']).toBe('Bearer oauth-test-token');
    expect(calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    const body = JSON.parse(calls[0]!.body) as { stream: boolean; system: Array<{ text: string }>; tools: Array<{ name: string }> };
    expect(body.stream).toBe(true);
    expect(body.system[0]!.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.tools[0]!.name).toBe('mcp__connect'); // sanitized on the wire

    // Reverse map restores dotted originals on BOTH tool events.
    expect(events).toEqual([
      { type: 'tool_use_start', id: 'tu_1', name: 'mcp.connect' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: '{"url":"https://x"}' },
      { type: 'tool_use_end', id: 'tu_1', name: 'mcp.connect', input: { url: 'https://x' } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 10, out: 5, cached_in: 0 } },
    ]);

    const irRes = JSON.parse(readRow('trace-stream-1')['ir_response'] as string) as {
      blocks: Array<{ name?: string }>;
    };
    expect(irRes.blocks[0]!.name).toBe('mcp.connect'); // row stores reversed names too
  });
});

// ---------------------------------------------------------------------------
// Prep failures
// ---------------------------------------------------------------------------

describe('streamIR — prep failures', () => {
  it('unknown provider: invalid_request throw before any fetch, row written', async () => {
    const { fetchImpl, calls } = mockFetch([{ stream: () => sseStream(OPENAI_CHUNKS) }]);
    const err = await collect(streamIR(baseIR({ alias: 'nope/some-model' }), { fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('invalid_request');
    expect(calls).toHaveLength(0);
    expect(readRow('trace-stream-1')['error_class']).toBe('invalid_request');
  });
});

describe('stream_options usage accounting (openai family only)', () => {
  it('adds stream_options.include_usage on openai-family stream bodies, not anthropic', async () => {
    const { fetchImpl: f1, calls: c1 } = mockFetch([{ stream: () => sseStream([
      oai({ choices: [{ delta: { content: 'hi' }, index: 0 }] }),
      oai({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }),
      'data: [DONE]\n\n',
    ]) }]);
    await collect(streamIR(baseIR({ alias: 'xai/grok-4-fast' }), { fetchImpl: f1 }));
    const openaiBody = JSON.parse(c1[0]!.body) as Record<string, unknown>;
    expect(openaiBody['stream_options']).toEqual({ include_usage: true });

    const { fetchImpl: f2, calls: c2 } = mockFetch([{ stream: () => sseStream([
      ant({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
      ant({ type: 'message_stop' }),
    ]) }]);
    await collect(streamIR(baseIR({ alias: 'anthropic/claude-opus-4-7' }), { fetchImpl: f2 }));
    const anthropicBody = JSON.parse(c2[0]!.body) as Record<string, unknown>;
    expect(anthropicBody['stream_options']).toBeUndefined();
    expect(anthropicBody['stream']).toBe(true);
  });
});
