/**
 * @file tests/llm/transport.test.ts
 * @description Unit tests for the in-process IR transport (gw-cutover Phase 0,
 * non-streaming). All network is a mocked fetchImpl — NO real provider calls.
 * The claude-oauth manager module is vi.mock'd so its token accessor shape is
 * pinned without touching disk credentials.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IRRequest, IRResponse } from '../../shared-types/ir/v1.js';
import { callIR } from '../../src/llm/transport.js';
import { LLMPolicyError } from '../../src/llm/errors.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { sha256Hex, __resetGatewayCallLog, getGatewayCallLog } from '../../src/llm/logging.js';
import {
  registerCustomProvider,
  clearCustomProviders,
} from '../../src/llm/custom-providers.js';

// ---------------------------------------------------------------------------
// claude-oauth manager mock — pins the exact accessor shape the transport
// reuses (getAccessToken / refreshToken on the getClaudeOAuthManager singleton).
// ---------------------------------------------------------------------------

const oauthMock = {
  getAccessToken: vi.fn<() => string | null>(() => 'oauth-test-token'),
  refreshToken: vi.fn(async () => true),
  isAvailable: vi.fn(() => true),
};

vi.mock('../../src/llm/claude-oauth-manager.js', () => ({
  getClaudeOAuthManager: () => oauthMock,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'xai/grok-4-fast-non-reasoning',
    caller: 'test',
    purpose: 'transport-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-transport-1',
    max_tokens: 128,
    ...partial,
  };
}

const OPENAI_TEXT_WIRE = {
  choices: [{ message: { role: 'assistant', content: 'Hello back.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
};

const ANTHROPIC_TEXT_WIRE = {
  content: [{ type: 'text', text: 'Hello back.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** fetchImpl stub: replies from a queue (last entry repeats) and captures. */
function mockFetch(replies: Array<{ status: number; json: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), headers, body: String(init?.body) });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => {};

const ENV_KEYS = [
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OLLAMA_URL',
  'OLLAMA_API_KEY',
  'SUDO_LLM_RETRY_DISABLE',
  'SUDO_GATEWAY_LOG_TEST',
] as const;
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['XAI_API_KEY'] = 'xai-test-key';
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  delete process.env['SUDO_LLM_RETRY_DISABLE'];
  delete process.env['SUDO_GATEWAY_LOG_TEST'];
  __resetPolicyState();
  oauthMock.getAccessToken.mockClear();
  oauthMock.refreshToken.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  clearCustomProviders();
  __resetGatewayCallLog();
});

// ---------------------------------------------------------------------------
// Happy paths per family
// ---------------------------------------------------------------------------

describe('callIR — openai-compat family', () => {
  it('text happy path: URL, bare model id, bearer auth header present, parsed IRResponse', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    const res = await callIR(baseIR(), { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    // Auth header present, without asserting a real secret shape.
    expect(calls[0]!.headers['authorization']).toBe('Bearer xai-test-key');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe('grok-4-fast-non-reasoning'); // prefix stripped, once
    expect(body['max_tokens']).toBe(128);
    expect(body['messages']).toEqual([{ role: 'user', content: 'Hi' }]);

    expect(res.blocks).toEqual([{ type: 'text', text: 'Hello back.' }]);
    expect(res.stop_reason).toBe('end_turn');
    // OpenAI prompt_tokens is ALREADY cache-inclusive — no summing on this family.
    expect(res.usage).toEqual({ in: 12, out: 4, cached_in: 3 });
    expect(res.trace_id).toBe('trace-transport-1');
  });

  it('tools round trip: response tool_calls string args → tool_use with OBJECT input', async () => {
    const wire = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 18 },
    };
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
    const ir = baseIR({
      tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });
    const res = await callIR(ir, { fetchImpl });

    const body = JSON.parse(calls[0]!.body) as { tools: Array<{ function: { name: string } }> };
    expect(body.tools[0]!.function.name).toBe('get_weather');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
  });

  it('ollama routes to OLLAMA_URL with the default bearer, no API key required', async () => {
    process.env['OLLAMA_URL'] = 'http://localhost:11434/v1/';
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'ollama/llama3.2' }), { fetchImpl });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer ollama');
    expect((JSON.parse(calls[0]!.body) as Record<string, unknown>)['model']).toBe('llama3.2');
  });

  it('custom provider routes to its registered baseURL with its own key', async () => {
    expect(
      registerCustomProvider(
        { name: 'myprov', baseURL: 'https://llm.example.com/v1', apiKey: 'custom-key-1' },
        new Set(),
      ),
    ).toBe(true);
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'myprov/some-model' }), { fetchImpl });
    expect(calls[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer custom-key-1');
    expect((JSON.parse(calls[0]!.body) as Record<string, unknown>)['model']).toBe('some-model');
  });
});

describe('callIR — anthropic family', () => {
  it('text happy path: /v1/messages, x-api-key + anthropic-version, max_tokens always set', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: ANTHROPIC_TEXT_WIRE }]);
    // NO ir.max_tokens → the egress adapter must still set one (alias limits).
    const ir = baseIR({ alias: 'anthropic/claude-opus-4-8' });
    delete (ir as { max_tokens?: number }).max_tokens;
    const res = await callIR(ir, { fetchImpl });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['anthropic-beta']).toBeUndefined(); // API-key path: no oauth beta
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['model']).toBe('claude-opus-4-8');
    expect(typeof body['max_tokens']).toBe('number');
    expect(body['max_tokens'] as number).toBeGreaterThan(0);
    expect(res.blocks).toEqual([{ type: 'text', text: 'Hello back.' }]);
    // IRUsage invariant: in = TOTAL input incl. cache reads (12 + 3).
    expect(res.usage).toEqual({ in: 15, out: 4, cached_in: 3 });
  });

  it('response_schema → forced structured_output tool on the wire, tool_use parsed to object args', async () => {
    const wire = {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'structured_output', input: { verdict: 'pass' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 9 },
    };
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
    const res = await callIR(
      baseIR({
        alias: 'anthropic/claude-opus-4-8',
        response_schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
      }),
      { fetchImpl },
    );

    const body = JSON.parse(calls[0]!.body) as {
      tools: Array<{ name: string }>;
      tool_choice: { type: string; name: string };
    };
    expect(body.tools.at(-1)!.name).toBe('structured_output');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'structured_output' });
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'structured_output', input: { verdict: 'pass' } },
    ]);
  });

  it('thinking blocks in request history pass through to the anthropic wire', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: ANTHROPIC_TEXT_WIRE }]);
    await callIR(
      baseIR({
        alias: 'anthropic/claude-opus-4-8',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Q' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private chain', signature: 'sig-1' },
              { type: 'text', text: 'A' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'more' }] },
        ],
      }),
      { fetchImpl },
    );
    const body = JSON.parse(calls[0]!.body) as { messages: Array<{ content: unknown[] }> };
    expect(body.messages[1]!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'private chain',
      signature: 'sig-1',
    });
  });
});

// ---------------------------------------------------------------------------
// claude-oauth
// ---------------------------------------------------------------------------

describe('callIR — claude-oauth', () => {
  it('sends the legacy oauth headers verbatim and the Claude Code attestation', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: ANTHROPIC_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'claude-oauth/claude-opus-4-8', system: 'Be terse.' }), { fetchImpl });

    expect(oauthMock.getAccessToken).toHaveBeenCalled();
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['authorization']).toBe('Bearer oauth-test-token');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(calls[0]!.body) as { model: string; system: Array<{ text: string }> };
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.system[0]!.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.system[1]!.text).toBe('Be terse.');
  });

  it('refreshes via the shared manager when the token is inside the buffer', async () => {
    oauthMock.getAccessToken.mockReturnValueOnce(null).mockReturnValue('refreshed-token');
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: ANTHROPIC_TEXT_WIRE }]);
    await callIR(baseIR({ alias: 'claude-oauth/claude-opus-4-8' }), { fetchImpl });
    expect(oauthMock.refreshToken).toHaveBeenCalledTimes(1);
    expect(calls[0]!.headers['authorization']).toBe('Bearer refreshed-token');
  });

  it('sanitizes reserved tool names on the wire and reverses them on tool_use blocks', async () => {
    const wire = {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__connect', input: { url: 'https://x' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
    const res = await callIR(
      baseIR({
        alias: 'claude-oauth/claude-opus-4-8',
        tools: [{ name: 'mcp.connect', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }],
      }),
      { fetchImpl },
    );

    const body = JSON.parse(calls[0]!.body) as { tools: Array<{ name: string }> };
    // 'mcp.connect' → 'mcp_connect' (dot) → 'mcp__connect' (reserved-prefix lift, #685).
    expect(body.tools[0]!.name).toBe('mcp__connect');
    // Reverse map restores the dotted original the dispatcher expects.
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'mcp.connect', input: { url: 'https://x' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Errors + policy
// ---------------------------------------------------------------------------

describe('callIR — errors and policy', () => {
  it('429 with retries disabled classifies as rate_limited (single attempt)', async () => {
    process.env['SUDO_LLM_RETRY_DISABLE'] = '1';
    const { fetchImpl, calls } = mockFetch([
      { status: 429, json: { error: { message: 'Rate limit reached for requests', type: 'requests' } } },
    ]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('rate_limited');
    expect((err as LLMPolicyError).status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('429 then 200: policy retries and the call succeeds (injected sleep/rng)', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 429, json: { error: { message: 'Rate limit reached for requests' } } },
      { status: 200, json: OPENAI_TEXT_WIRE },
    ]);
    const res = await callIR(baseIR(), { fetchImpl, sleep: noSleep, rng: () => 0.5 });
    expect(calls).toHaveLength(2);
    expect(res.stop_reason).toBe('end_turn');
  });

  it('HTTP 200 garbage → IRResponse stop_reason error + extra.provider_bug, NOT a throw', async () => {
    const { fetchImpl } = mockFetch([{ status: 200, json: { id: 'chatcmpl-x' } }]);
    const res: IRResponse = await callIR(baseIR(), { fetchImpl });
    expect(res.stop_reason).toBe('error');
    expect(res.extra?.['provider_bug']).toBe(true);
    expect(res.blocks).toEqual([]);
  });

  it('missing API key → invalid_request throw, fetch never called', async () => {
    delete process.env['XAI_API_KEY'];
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    const err = await callIR(baseIR(), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('unknown provider → invalid_request throw', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    const err = await callIR(baseIR({ alias: 'nope/some-model' }), { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// llm_calls logging
// ---------------------------------------------------------------------------

describe('callIR — llm_calls row', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transport-log-'));
    process.env['SUDO_GATEWAY_LOG_TEST'] = '1';
    __resetGatewayCallLog();
    getGatewayCallLog(join(dir, 'gateway.db')); // bind singleton to the temp DB
  });

  afterEach(() => {
    __resetGatewayCallLog();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one row with full IR, route, tokens and the exact wire sha256', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 200, json: OPENAI_TEXT_WIRE }]);
    const ir = baseIR({ trace_id: 'trace-log-1' });
    await callIR(ir, { fetchImpl });

    const db = new Database(join(dir, 'gateway.db'), { readonly: true });
    const rows = db.prepare('SELECT * FROM llm_calls').all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['trace_id']).toBe('trace-log-1');
    expect(row['caller']).toBe('test');
    expect(row['route']).toBe('xai:chat');
    expect(row['priority']).toBe('user');
    expect(row['error_class']).toBeNull();
    expect(row['tokens_in']).toBe(12);
    expect(row['tokens_out']).toBe(4);
    expect(row['tokens_cached']).toBe(3);
    expect(typeof row['latency_ms']).toBe('number');
    // FULL ir_request/ir_response (not a {legacy:true} summary).
    const irReq = JSON.parse(row['ir_request'] as string) as { alias: string; messages: unknown[] };
    expect(irReq.alias).toBe('xai/grok-4-fast-non-reasoning');
    expect(irReq.messages).toHaveLength(1);
    const irRes = JSON.parse(row['ir_response'] as string) as { stop_reason: string };
    expect(irRes.stop_reason).toBe('end_turn');
    // sha256 of the EXACT serialized wire body.
    expect(row['wire_payload_sha256']).toBe(sha256Hex(calls[0]!.body));
  });

  it('failure path still writes a row with error_class', async () => {
    process.env['SUDO_LLM_RETRY_DISABLE'] = '1';
    const { fetchImpl } = mockFetch([{ status: 401, json: { error: { message: 'Incorrect API key provided' } } }]);
    await expect(callIR(baseIR({ trace_id: 'trace-log-2' }), { fetchImpl })).rejects.toBeInstanceOf(LLMPolicyError);

    const db = new Database(join(dir, 'gateway.db'), { readonly: true });
    const row = db.prepare('SELECT * FROM llm_calls WHERE trace_id = ?').get('trace-log-2') as Record<string, unknown>;
    db.close();
    expect(row['error_class']).toBe('auth');
    expect(typeof row['wire_payload_sha256']).toBe('string');
  });
});

describe('anthropic temperature deprecation strip (legacy providers.ts parity)', () => {
  const wire = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } };

  it('strips temperature for opus-4-8 and claude-*-5 family', async () => {
    for (const model of ['anthropic/claude-opus-4-8', 'anthropic/claude-fable-5', 'anthropic/claude-sonnet-5']) {
      const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
      await callIR(baseIR({ alias: model, temperature: 0.7 }), { fetchImpl });
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
      expect(body['temperature'], model).toBeUndefined();
    }
  });

  it('keeps temperature for older models (opus-4-7, haiku-4-5)', async () => {
    for (const model of ['anthropic/claude-opus-4-7', 'anthropic/claude-haiku-4-5']) {
      const { fetchImpl, calls } = mockFetch([{ status: 200, json: wire }]);
      await callIR(baseIR({ alias: model, temperature: 0.7 }), { fetchImpl });
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
      expect(body['temperature'], model).toBe(0.7);
    }
  });
});
