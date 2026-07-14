/**
 * @file tests/conformance/harness.ts
 * @description Golden-matrix conformance harness for the LLM gateway adapters
 * (gw-refactor Phase 6). Defines the case list per adapter; each case produces
 * an OUTPUT OBJECT (egress body / parsed IRResponse / stream event array /
 * error classification) that is compared against a committed golden JSON at
 * tests/conformance/goldens/<adapter>/<case>.json via deep-equal on a
 * stable-stringified (sorted-keys) rendering.
 *
 * - Missing golden = test failure with "run pnpm conformance:update".
 * - CONFORMANCE_UPDATE=1 makes the same vitest run WRITE goldens instead.
 * - Outputs whose stable JSON exceeds DIGEST_THRESHOLD bytes are stored as a
 *   digest {__digest, bytes, sha256} so the 100k-context case does not commit
 *   400KB of JSON.
 *
 * This suite EXTENDS the goldens in tests/llm/adapters/*.test.ts — those
 * remain the behavioural unit tests; this is the systematic file-based matrix.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IRRequest, IRResponse } from '../../shared-types/ir/v1.js';
import { egressOpenAI, parseOpenAIResponse } from '../../src/llm/adapters/egress-openai.js';
import { egressAnthropic, parseAnthropicResponse } from '../../src/llm/adapters/egress-anthropic.js';
import { ingressOpenAI, type IngressMeta } from '../../src/llm/adapters/ingress-openai.js';
import { streamIR, type IRStreamEvent } from '../../src/llm/adapters/stream.js';
import {
  classifyHttpError,
  classifyOpenAIResponse,
  classifyAnthropicResponse,
  classifyThrown,
  isRetryable,
  type LLMErrorClass,
} from '../../src/llm/errors.js';
import { estimateTokens } from '../../src/llm/limits.js';

// ---------------------------------------------------------------------------
// Golden I/O
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDENS_DIR = join(HERE, 'goldens');

/** Outputs whose stable JSON exceeds this many bytes are stored as a digest. */
export const DIGEST_THRESHOLD = 32 * 1024;

export const UPDATE_MODE = process.env['CONFORMANCE_UPDATE'] === '1';

/** JSON.stringify with recursively sorted object keys — diff-stable goldens. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortKeys(rec[k]);
    return out;
  }
  return value;
}

/** Render an output for golden storage: verbatim, or a digest if oversized. */
export function renderGolden(output: unknown): string {
  const full = stableStringify(output);
  if (Buffer.byteLength(full, 'utf8') <= DIGEST_THRESHOLD) return full;
  const sha256 = createHash('sha256').update(full, 'utf8').digest('hex');
  return stableStringify({
    __digest: true,
    bytes: Buffer.byteLength(full, 'utf8'),
    sha256,
  });
}

export function goldenPath(adapter: string, caseName: string): string {
  return join(GOLDENS_DIR, adapter, `${caseName}.json`);
}

export function writeGolden(adapter: string, caseName: string, output: unknown): void {
  const path = goldenPath(adapter, caseName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${renderGolden(output)}\n`, 'utf8');
}

export function readGolden(adapter: string, caseName: string): string | undefined {
  const path = goldenPath(adapter, caseName);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Shared IR fixtures (egress-openai + egress-anthropic)
// ---------------------------------------------------------------------------

/** Unknown to aliases.ts and limits.ts → deterministic (no env overrides). */
const MODEL = 'testprov/conformance-model-1';
const TRACE = 'trace-conformance-0001';

function baseIR(partial: Partial<IRRequest>): IRRequest {
  return {
    alias: MODEL,
    caller: 'conformance',
    purpose: 'golden-matrix',
    messages: [],
    priority: 'user',
    trace_id: TRACE,
    max_tokens: 1024,
    ...partial,
  };
}

/** Rich JSON Schema — descriptions/enums/required/nested — fidelity case. */
export const RICH_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: 'Create a calendar event with attendees and recurrence.',
  properties: {
    title: { type: 'string', description: 'Event title', minLength: 1 },
    kind: { type: 'string', enum: ['meeting', 'reminder', 'ooo'], description: 'Event kind' },
    when: {
      type: 'object',
      description: 'Start/end pair',
      properties: {
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
        tz: { type: 'string', default: 'UTC' },
      },
      required: ['start', 'end'],
    },
    attendees: {
      type: 'array',
      description: 'People to invite',
      items: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          optional: { type: 'boolean', default: false },
        },
        required: ['email'],
      },
      minItems: 1,
    },
    recurrence: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            interval: { type: 'integer', minimum: 1, maximum: 52 },
          },
          required: ['freq'],
        },
      ],
    },
  },
  required: ['title', 'when'],
  additionalProperties: false,
};

/** ~100k tokens of messages (≈ 400k chars at 4 chars/token). */
export function build100kIR(): IRRequest {
  const paragraph =
    'The quick brown fox jumps over the lazy dog while the gateway counts tokens. ';
  // 50 messages x ~8000 chars ≈ 400,000 chars ≈ 100k tokens.
  const chunk = paragraph.repeat(Math.ceil(8000 / paragraph.length));
  const messages: IRRequest['messages'] = [];
  for (let i = 0; i < 50; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `[msg ${String(i).padStart(2, '0')}] ${chunk}` }],
    });
  }
  // Sentinel used by the no-truncation assertion in the test file.
  messages.push({ role: 'user', content: [{ type: 'text', text: CONTEXT_SENTINEL }] });
  return baseIR({ messages, max_tokens: 2048 });
}

export const CONTEXT_SENTINEL = 'FINAL-SENTINEL-4242: reply with the summary of everything above.';

export interface IRCase {
  name: string;
  ir: IRRequest;
  /** Skip-if-unsupported pattern: adapters the case does not apply to. */
  skip?: ReadonlyArray<'egress-openai' | 'egress-anthropic'>;
}

export const IR_CASES: IRCase[] = [
  {
    name: 'text',
    ir: baseIR({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello, gateway.' }] }],
      // No max_tokens: pins the anthropic default (getAliasLimits → DEFAULT_LIMITS).
      max_tokens: undefined as unknown as number,
    }),
  },
  {
    name: 'system',
    ir: baseIR({
      system: 'You are a terse assistant. Answer in one sentence.',
      // temperature above Anthropic's range: openai passes 1.5, anthropic clamps to 1.
      temperature: 1.5,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is IR v1?' }] }],
    }),
  },
  {
    name: 'tool-single',
    ir: baseIR({
      temperature: 0.2,
      tools: [
        {
          name: 'get_weather',
          description: 'Look up current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } },
          ],
        },
      ],
    }),
  },
  {
    name: 'tools-parallel',
    ir: baseIR({
      tools: [
        { name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
        { name: 'get_time', input_schema: { type: 'object', properties: { tz: { type: 'string' } } } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather and time in Oslo?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } },
            { type: 'tool_use', id: 'tu_2', name: 'get_time', input: { tz: 'Europe/Oslo' } },
          ],
        },
      ],
    }),
  },
  {
    name: 'tool-result-turn',
    ir: baseIR({
      tools: [
        { name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo and Bergen?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } },
            { type: 'tool_use', id: 'tu_2', name: 'get_weather', input: { city: 'Bergen' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '4°C, cloudy' },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'lookup failed: no station', is_error: true },
            { type: 'text', text: 'Bergen failed — just give me Oslo.' },
          ],
        },
      ],
    }),
  },
  {
    name: 'image-block',
    ir: baseIR({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe these.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8taW1hZ2U=' },
            },
            { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    }),
  },
  {
    name: 'structured-output',
    ir: baseIR({
      response_schema: {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } },
        required: ['verdict'],
      },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Grade this.' }] }],
    }),
  },
  {
    name: 'tool-schema-fidelity',
    ir: baseIR({
      tools: [
        { name: 'create_event', description: 'Create a calendar event.', input_schema: RICH_TOOL_SCHEMA },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Book a standup.' }] }],
    }),
  },
  {
    name: 'context-100k',
    ir: build100kIR(),
  },
];

// Strip the deliberately-undefined max_tokens so IR stays schema-clean.
for (const c of IR_CASES) {
  if (c.ir.max_tokens === undefined) delete (c.ir as { max_tokens?: number }).max_tokens;
}

// ---------------------------------------------------------------------------
// Response-parse fixtures (parse-openai / parse-anthropic)
// ---------------------------------------------------------------------------

export interface ParseCase {
  name: string;
  wire: unknown;
}

export const PARSE_OPENAI_CASES: ParseCase[] = [
  {
    name: 'text',
    wire: {
      choices: [{ message: { role: 'assistant', content: 'Hello back.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
    },
  },
  {
    name: 'tools-parallel',
    wire: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
              { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{"tz":"Europe/Oslo"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 18 },
    },
  },
  {
    name: 'malformed-args-repaired',
    wire: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            // Single quotes + trailing comma: JSON.parse fails, jsonrepair fixes.
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: "{'city': 'Oslo',}" } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 9 },
    },
  },
  {
    name: 'malformed-args-unrecoverable',
    wire: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            // Parses (after repair) to a non-object → {} + parse_error.
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '"just a bare string"' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  },
  {
    name: 'provider-lies-garbage-200',
    // HTTP 200 whose body has no choices at all.
    wire: { id: 'chatcmpl-x', object: 'chat.completion' },
  },
  {
    name: 'content-filter-finish',
    wire: {
      choices: [{ message: { role: 'assistant', content: 'I cannot help with that.' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 8, completion_tokens: 7 },
    },
  },
];

export const PARSE_ANTHROPIC_CASES: ParseCase[] = [
  {
    name: 'text',
    wire: {
      content: [{ type: 'text', text: 'Hello back.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
    },
  },
  {
    name: 'tools-parallel',
    wire: {
      content: [
        { type: 'text', text: 'Checking both.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo' } },
        { type: 'tool_use', id: 'tu_2', name: 'get_time', input: { tz: 'Europe/Oslo' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 30, output_tokens: 18 },
    },
  },
  {
    name: 'malformed-args-repaired',
    wire: {
      // Defensive path: input arrives as a STRING → parseToolArguments.
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: "{'city': 'Oslo',}" }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 9 },
    },
  },
  {
    name: 'malformed-args-unrecoverable',
    wire: {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: '"just a bare string"' }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    name: 'provider-lies-garbage-200',
    // HTTP 200 whose content is empty.
    wire: { id: 'msg_x', type: 'message', content: [], stop_reason: 'end_turn' },
  },
  {
    name: 'refusal-stop-reason',
    wire: {
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 8, output_tokens: 7 },
    },
  },
];

// ---------------------------------------------------------------------------
// Ingress fixtures (OpenAI request body → IR)
// ---------------------------------------------------------------------------

export interface IngressCase {
  name: string;
  body: unknown;
  meta: IngressMeta;
}

const INGRESS_META: IngressMeta = {
  caller: 'conformance',
  purpose: 'golden-matrix',
  trace_id: TRACE,
};

export const INGRESS_OPENAI_CASES: IngressCase[] = [
  {
    name: 'text',
    body: {
      model: 'testprov/conformance-model-1',
      messages: [{ role: 'user', content: 'Hello, gateway.' }],
    },
    meta: INGRESS_META,
  },
  {
    name: 'system',
    body: {
      model: 'testprov/conformance-model-1',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'developer', content: 'Answer in one sentence.' },
        { role: 'user', content: 'What is IR v1?' },
      ],
      temperature: 0.5,
      max_tokens: 256,
    },
    meta: INGRESS_META,
  },
  {
    name: 'tool-result-turn',
    body: {
      model: 'testprov/conformance-model-1',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up current weather for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
      messages: [
        { role: 'user', content: 'Weather in Oslo and Bergen?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
            { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bergen"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '4°C, cloudy' },
        { role: 'tool', tool_call_id: 'call_2', content: 'lookup failed' },
        { role: 'user', content: 'Thanks.' },
      ],
    },
    meta: INGRESS_META,
  },
  {
    name: 'malformed-args',
    body: {
      model: 'testprov/conformance-model-1',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: 'not json {{{' } },
          ],
        },
      ],
    },
    meta: INGRESS_META,
  },
  {
    name: 'image-data-url',
    body: {
      model: 'testprov/conformance-model-1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8taW1hZ2U=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    },
    meta: INGRESS_META,
  },
  {
    name: 'extras-passthrough',
    body: {
      model: 'testprov/conformance-model-1',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.9,
      seed: 42,
      stream_options: { include_usage: true },
    },
    meta: INGRESS_META,
  },
  {
    name: 'tool-schema-fidelity',
    body: {
      model: 'testprov/conformance-model-1',
      tools: [
        {
          type: 'function',
          function: { name: 'create_event', description: 'Create a calendar event.', parameters: RICH_TOOL_SCHEMA },
        },
      ],
      messages: [{ role: 'user', content: 'Book a standup.' }],
    },
    meta: INGRESS_META,
  },
];

// ---------------------------------------------------------------------------
// Stream fixtures (SSE machines)
// ---------------------------------------------------------------------------

export interface StreamCase {
  name: string;
  target: 'openai' | 'anthropic';
  script: unknown[];
  /**
   * end      — transport saw a clean close ([DONE] / socket end) after script.
   * truncate — script ends abruptly (mid tool args); transport still calls
   *            end() — golden pins the terminal flush behaviour.
   * abort    — transport calls fail('...') after the script (first token
   *            already emitted) — golden pins stream_error + terminal
   *            message_end; single-use is asserted in the test file.
   * none     — script is self-terminating (e.g. anthropic message_stop /
   *            in-band error event).
   */
  finish: 'end' | 'truncate' | 'abort' | 'none';
}

const OPENAI_TOOL_SCRIPT: unknown[] = [
  { choices: [{ delta: { role: 'assistant', content: 'Let me ' } }] },
  { choices: [{ delta: { content: 'check.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 25, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 10 } } },
];

const ANTHROPIC_TOOL_SCRIPT: unknown[] = [
  { type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Oslo"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
  { type: 'message_stop' },
];

export const STREAM_CASES: StreamCase[] = [
  { name: 'text-and-tool', target: 'openai', script: OPENAI_TOOL_SCRIPT, finish: 'end' },
  { name: 'text-and-tool', target: 'anthropic', script: ANTHROPIC_TOOL_SCRIPT, finish: 'none' },
  {
    name: 'truncation-mid-stream',
    target: 'openai',
    // Cuts off mid tool-argument accumulation; no finish_reason, no usage chunk.
    script: OPENAI_TOOL_SCRIPT.slice(0, 4),
    finish: 'truncate',
  },
  {
    name: 'truncation-mid-stream',
    target: 'anthropic',
    // Cuts off mid input_json_delta; no content_block_stop / message_stop.
    script: ANTHROPIC_TOOL_SCRIPT.slice(0, 7),
    finish: 'truncate',
  },
  {
    name: 'abort-after-first-token',
    target: 'openai',
    script: [{ choices: [{ delta: { content: 'partial an' } }] }],
    finish: 'abort',
  },
  {
    name: 'abort-after-first-token',
    target: 'anthropic',
    script: [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial an' } },
    ],
    finish: 'abort',
  },
];

/** Run a stream case on a FRESH machine; returns every emitted event. */
export function runStreamCase(c: StreamCase): IRStreamEvent[] {
  const machine = streamIR(c.target);
  const out: IRStreamEvent[] = [];
  for (const ev of c.script) out.push(...machine.push(ev));
  if (c.finish === 'end' || c.finish === 'truncate') out.push(...machine.end());
  if (c.finish === 'abort') out.push(...machine.fail('upstream socket reset'));
  return out;
}

// ---------------------------------------------------------------------------
// Error-taxonomy fixtures — one case per LLMErrorClass (all 11)
// ---------------------------------------------------------------------------

export interface ErrorCase {
  name: string;
  /** Human-readable driver description, stored in the golden for review. */
  input: Record<string, unknown>;
  run: () => LLMErrorClass | null;
}

function httpCase(name: string, status: number, body: string): ErrorCase {
  return {
    name,
    input: { via: 'classifyHttpError', status, body },
    run: () => classifyHttpError(status, body),
  };
}

export const ERROR_CASES: ErrorCase[] = [
  httpCase('rate-limited', 429, '{"error":{"message":"Rate limit reached for requests","type":"requests"}}'),
  httpCase('overloaded', 503, '{"error":{"type":"overloaded_error","message":"Overloaded"}}'),
  httpCase('timeout', 408, 'Request Timeout'),
  httpCase(
    'context-exceeded',
    400,
    '{"error":{"type":"invalid_request_error","message":"prompt is too long: 250123 tokens > 200000 maximum"}}',
  ),
  httpCase('billing', 402, 'Payment Required'),
  httpCase('auth', 401, '{"error":{"message":"Incorrect API key provided"}}'),
  httpCase(
    'content-filter',
    400,
    '{"error":{"message":"Your request was rejected by the content policy filter","code":"content_policy_violation"}}',
  ),
  httpCase('invalid-request', 400, '{"error":{"message":"Invalid value for parameter temperature: 9.5"}}'),
  {
    name: 'provider-bug',
    input: { via: 'classifyOpenAIResponse', wire: 'HTTP 200 with no choices' },
    run: () => classifyOpenAIResponse(parseOpenAIResponse({ id: 'chatcmpl-x' }, TRACE)),
  },
  {
    name: 'network',
    input: { via: 'classifyThrown', thrown: "TypeError('fetch failed')" },
    run: () => classifyThrown(new TypeError('fetch failed')),
  },
  {
    name: 'unknown',
    input: { via: 'classifyThrown', thrown: "Error('mystery failure with no signature')" },
    run: () => classifyThrown(new Error('mystery failure with no signature')),
  },
  // Extra wire variants — same classes, other entry points.
  {
    name: 'content-filter-anthropic-refusal',
    input: { via: 'classifyAnthropicResponse', wire: 'HTTP 200 with stop_reason refusal' },
    run: () =>
      classifyAnthropicResponse(
        parseAnthropicResponse(
          { content: [{ type: 'text', text: 'no' }], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 1 } },
          TRACE,
        ),
      ),
  },
  {
    name: 'content-filter-openai-finish',
    input: { via: 'classifyOpenAIResponse', wire: 'HTTP 200 with finish_reason content_filter' },
    run: () =>
      classifyOpenAIResponse(
        parseOpenAIResponse(
          { choices: [{ message: { content: 'no' }, finish_reason: 'content_filter' }], usage: {} },
          TRACE,
        ),
      ),
  },
  {
    name: 'timeout-thrown-abort',
    input: { via: 'classifyThrown', thrown: 'AbortError' },
    run: () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      return classifyThrown(err);
    },
  },
];

export function runErrorCase(c: ErrorCase): Record<string, unknown> {
  const cls = c.run();
  return {
    input: c.input,
    class: cls,
    retryable: cls === null ? null : isRetryable(cls),
  };
}

// ---------------------------------------------------------------------------
// Adapter matrix — the single source the test file iterates
// ---------------------------------------------------------------------------

export interface MatrixCase {
  name: string;
  produce: () => unknown;
}

export const ADAPTER_MATRIX: Record<string, MatrixCase[]> = {
  'egress-openai': IR_CASES.filter((c) => !c.skip?.includes('egress-openai')).map((c) => ({
    name: c.name,
    produce: () => egressOpenAI(c.ir),
  })),
  'egress-anthropic': IR_CASES.filter((c) => !c.skip?.includes('egress-anthropic')).map((c) => ({
    name: c.name,
    produce: () => egressAnthropic(c.ir),
  })),
  'parse-openai': PARSE_OPENAI_CASES.map((c) => ({
    name: c.name,
    produce: () => parseOpenAIResponse(c.wire, TRACE),
  })),
  'parse-anthropic': PARSE_ANTHROPIC_CASES.map((c) => ({
    name: c.name,
    produce: () => parseAnthropicResponse(c.wire, TRACE),
  })),
  'ingress-openai': INGRESS_OPENAI_CASES.map((c) => ({
    name: c.name,
    produce: () => ingressOpenAI(c.body, c.meta),
  })),
  'stream-openai': STREAM_CASES.filter((c) => c.target === 'openai').map((c) => ({
    name: c.name,
    produce: () => runStreamCase(c),
  })),
  'stream-anthropic': STREAM_CASES.filter((c) => c.target === 'anthropic').map((c) => ({
    name: c.name,
    produce: () => runStreamCase(c),
  })),
  errors: ERROR_CASES.map((c) => ({ name: c.name, produce: () => runErrorCase(c) })),
};

// Re-exports the test file needs for the targeted (non-golden) assertions.
export { egressOpenAI, egressAnthropic, ingressOpenAI, parseOpenAIResponse, parseAnthropicResponse, streamIR, estimateTokens };
export type { IRRequest, IRResponse };
