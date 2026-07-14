/**
 * @file transport.ts
 * @description In-process IR transport (gw-cutover Phase 0 + Phase 1):
 * `callIR(ir)` = resolveAlias → provider family → egress adapter → authed
 * fetch → parse → IRResponse, the whole attempt wrapped in `runWithPolicy`.
 * `streamIR(ir)` = the same request preparation plus `stream: true`, parsing
 * the SSE byte stream through the single-use adapters/stream.ts machines and
 * yielding IRStreamEvents (RULE 4: retry only before the first machine event;
 * afterwards failures surface as stream_error + terminal message_end 'error').
 *
 * Families:
 * - `anthropic/` and `claude-oauth/` model prefixes → Anthropic Messages API
 *   (both hit PROVIDER_BASE_URLS.anthropic — the legacy oauth manager also
 *   targets api.anthropic.com; see MODELS_URL in claude-oauth-manager.ts).
 * - Everything else → OpenAI-compatible chat completions:
 *   openai/xai/groq/deepseek from PROVIDER_BASE_URLS, `ollama/` from the
 *   OLLAMA_URL env (default https://ollama.com/v1, matching legacy
 *   providers.ts), and custom providers registered via SUDO_CUSTOM_PROVIDERS
 *   (their baseURL/key from getCustomProviderWireConfig).
 *
 * claude-oauth auth is REUSED from the legacy manager (single-flight refresh
 * rule — one refresher, never two): `getClaudeOAuthManager()` +
 * `getAccessToken()` / `refreshToken()`. The wire contract mirrors the legacy
 * fetch interceptor in legacy/providers.ts verbatim:
 * - headers: `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01`,
 *   `anthropic-beta: oauth-2025-04-20`.
 * - system-prompt attestation: the FIRST system block must be the exact
 *   Claude Code attestation sentence (Anthropic gates OAuth inference on it).
 * - tool names: sanitizeOAuthToolName (the reserved `mcp_` prefix 400 class,
 *   #685) with a per-call reverse map applied to response tool_use blocks.
 * Legacy-only request repairs (orphan tool_result strip, empty-text strip,
 * thinking-budget injection) are deliberately NOT ported here — the IR layer
 * never produces those malformations; they stay quarantined in legacy.
 *
 * Error semantics:
 * - non-2xx HTTP → classifyHttpError → LLMPolicyError THROWN (policy retries
 *   the retryable classes pre-first-token).
 * - thrown values (network/abort) → rethrown; policy classifies via
 *   classifyThrown.
 * - HTTP 200 garbage / refusals → parse*Response + classify*Response surface
 *   as an IRResponse with stop_reason 'error' + extra — RETURNED, never thrown.
 *
 * Logging: exactly one llm_calls row per callIR (success or failure), via the
 * same fail-open recordGatewayCall used by client.ts. FULL ir_request /
 * ir_response are stored (redaction happens inside logging.ts);
 * wire_payload_sha256 is the sha256 of the exact serialized wire body.
 */

import { randomUUID } from 'node:crypto';
import type { IRRequest, IRResponse, IRUsage } from '../../shared-types/ir/v1.js';
import { resolveAlias } from './aliases.js';
import { PROVIDER_BASE_URLS } from './endpoints.js';
import { getProviderApiKey, recordGatewayCall, type ProviderKeyName } from './client.js';
import { egressAnthropic, parseAnthropicResponse } from './adapters/egress-anthropic.js';
import { egressOpenAI, parseOpenAIResponse } from './adapters/egress-openai.js';
import {
  classifyHttpError,
  classifyThrown,
  classifyAnthropicResponse,
  classifyOpenAIResponse,
  LLMPolicyError,
  type LLMErrorClass,
} from './errors.js';
import { runWithPolicy } from './policy.js';
import {
  streamIR as createSSEMachine,
  type IRStreamEvent,
  type IRStreamMachine,
} from './adapters/stream.js';
import { sha256Hex, type LLMCallRecord } from './logging.js';
import { sanitizeOAuthToolName } from '../core/brain/tool-schema-compat.js';
import { getCustomProviderWireConfig } from './legacy/custom-providers.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm-transport');

// ---------------------------------------------------------------------------
// Wire constants (claude-oauth values mirror legacy claude-oauth-manager.ts /
// providers.ts — keep byte-identical, they are server-enforced).
// ---------------------------------------------------------------------------

/** Anthropic API version header — same value Claude Code sends. */
const ANTHROPIC_VERSION = '2023-06-01';
/** OAuth-specific beta header the inference API requires for OAuth tokens. */
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
/** Exact-prefix system attestation Anthropic gates OAuth inference on. */
const OAUTH_ATTESTATION = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Legacy providers.ts default for the ollama OpenAI-compatible endpoint. */
const OLLAMA_DEFAULT_URL = 'https://ollama.com/v1';

/** Built-in OpenAI-compatible providers with a PROVIDER_BASE_URLS entry. */
const OPENAI_COMPAT_BUILTINS: ReadonlySet<string> = new Set(['openai', 'xai', 'groq', 'deepseek']);

export interface CallIROptions {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Test seams forwarded to runWithPolicy (deterministic retry timing). */
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  /**
   * Disable policy retry for this call (runWithPolicy maxAttempts 1). For
   * callers that own retry themselves — Brain's failover loop already retries
   * across profiles; stacking policy's 3 attempts under it would multiply.
   * Breaker/lanes/budgets still apply.
   */
  noRetry?: boolean;
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

type Family = 'anthropic' | 'openai';

interface ResolvedRoute {
  family: Family;
  /** Provider prefix ('anthropic', 'claude-oauth', 'xai', 'ollama', custom name…). */
  provider: string;
  /** Bare model id with the provider prefix stripped. */
  modelId: string;
  /** Full endpoint URL. */
  url: string;
  /** Breaker/lane key: `<provider>:<messages|chat>`. */
  route: string;
}

function invalidRequest(message: string, route?: string): LLMPolicyError {
  return new LLMPolicyError(`[llm-transport] ${message}`, {
    class: 'invalid_request',
    retryable: false,
    ...(route !== undefined ? { route } : {}),
  });
}

/** Resolve alias → provider family + endpoint URL. Throws invalid_request. */
function resolveRoute(alias: string): ResolvedRoute {
  const resolved = resolveAlias(alias);
  const slash = resolved.indexOf('/');
  if (slash <= 0 || slash === resolved.length - 1) {
    throw invalidRequest(`invalid model string "${resolved}" — expected "provider/model-id"`);
  }
  const provider = resolved.slice(0, slash);
  const modelId = resolved.slice(slash + 1);

  if (provider === 'anthropic' || provider === 'claude-oauth') {
    // claude-oauth uses the SAME api.anthropic.com base as anthropic — the
    // oauth manager's own /v1/models fetch targets that host (verified in
    // legacy/claude-oauth-manager.ts). Distinct route key so an oauth outage
    // never opens the API-key anthropic breaker (and vice versa).
    return {
      family: 'anthropic',
      provider,
      modelId,
      url: `${PROVIDER_BASE_URLS.anthropic}/messages`,
      route: `${provider}:messages`,
    };
  }

  let baseURL: string | undefined;
  if (OPENAI_COMPAT_BUILTINS.has(provider)) {
    baseURL = PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS];
  } else if (provider === 'ollama') {
    const env = process.env['OLLAMA_URL']?.trim();
    baseURL = (env !== undefined && env !== '' ? env : OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
  } else {
    const custom = getCustomProviderWireConfig(provider);
    if (custom !== null) {
      if (custom.adapter === 'anthropic') {
        return {
          family: 'anthropic',
          provider,
          modelId,
          url: `${custom.baseURL.replace(/\/+$/, '')}/messages`,
          route: `${provider}:messages`,
        };
      }
      if (custom.adapter !== 'openai') {
        throw invalidRequest(
          `custom provider "${provider}" uses adapter "${custom.adapter}" — the IR transport supports openai/anthropic-shaped endpoints only`,
        );
      }
      baseURL = custom.baseURL.replace(/\/+$/, '');
    }
  }

  if (baseURL === undefined) {
    throw invalidRequest(`unknown provider "${provider}" in model string "${resolved}"`);
  }

  return {
    family: 'openai',
    provider,
    modelId,
    url: `${baseURL}/chat/completions`,
    route: `${provider}:chat`,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Build auth headers for the resolved route. Missing API key → invalid_request
 * throw (never a silent fallback). claude-oauth reuses the legacy manager's
 * token accessor — NEVER a second refresh implementation (single-flight rule).
 */
async function authHeaders(r: ResolvedRoute): Promise<Record<string, string>> {
  if (r.provider === 'claude-oauth') {
    const { getClaudeOAuthManager } = await import('./legacy/claude-oauth-manager.js');
    const mgr = getClaudeOAuthManager();
    let token = mgr.getAccessToken();
    if (token === null) {
      // Inside the refresh buffer / expired — same recovery the legacy fetch
      // interceptor performs (providers.ts claude-oauth create()).
      await mgr.refreshToken();
      token = mgr.getAccessToken();
    }
    if (token === null) {
      throw new LLMPolicyError(
        '[llm-transport] claude-oauth: no usable token — run `sudo-ai claude-oauth login`',
        { class: 'auth', retryable: false, route: r.route },
      );
    }
    return {
      Authorization: `Bearer ${token}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    };
  }

  if (r.family === 'anthropic') {
    if (r.provider !== 'anthropic') {
      // anthropic-shaped custom provider — key from its own wire config.
      const custom = getCustomProviderWireConfig(r.provider);
      if (custom === null) throw invalidRequest(`custom provider "${r.provider}" vanished`, r.route);
      return { 'x-api-key': custom.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    }
    const key = getProviderApiKey('anthropic') ?? process.env['ANTHROPIC_AUTH_TOKEN']?.trim() ?? '';
    if (key === '') {
      throw invalidRequest('anthropic: ANTHROPIC_API_KEY not configured', r.route);
    }
    // sk-ant-oat tokens authenticate via Bearer (legacy providers.ts nuance);
    // regular API keys use x-api-key.
    return key.startsWith('sk-ant-oat')
      ? { Authorization: `Bearer ${key}`, 'anthropic-version': ANTHROPIC_VERSION }
      : { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
  }

  // OpenAI-compatible family.
  if (r.provider === 'ollama') {
    // Keyless local / cloud-key optional — matches legacy providers.ts.
    return { Authorization: `Bearer ${process.env['OLLAMA_API_KEY'] ?? 'ollama'}` };
  }
  if (OPENAI_COMPAT_BUILTINS.has(r.provider)) {
    const key = getProviderApiKey(r.provider as ProviderKeyName);
    if (key === null) {
      throw invalidRequest(`${r.provider}: API key not configured`, r.route);
    }
    return { Authorization: `Bearer ${key}` };
  }
  const custom = getCustomProviderWireConfig(r.provider);
  if (custom === null) throw invalidRequest(`custom provider "${r.provider}" vanished`, r.route);
  return { Authorization: `Bearer ${custom.apiKey}` };
}

// ---------------------------------------------------------------------------
// claude-oauth body shaping (attestation + tool-name sanitisation)
// ---------------------------------------------------------------------------

/**
 * Apply the OAuth wire contract to an egressed Anthropic body IN PLACE and
 * return the sanitized→original tool-name map (empty when nothing was
 * rewritten). Mirrors legacy providers.ts sections 1 (attestation) and 2
 * (tool-name sanitise) exactly.
 */
export function applyOAuthBodyContract(body: Record<string, unknown>): Map<string, string> {
  // ---- system-prompt attestation (exact-prefix gate) ----
  const attestEntry = { type: 'text', text: OAUTH_ATTESTATION };
  const cur = body['system'];
  if (cur === undefined || cur === null) {
    body['system'] = [attestEntry];
  } else if (typeof cur === 'string') {
    body['system'] = cur.length > 0 ? [attestEntry, { type: 'text', text: cur }] : [attestEntry];
  } else if (Array.isArray(cur)) {
    const first = cur[0] as { text?: string } | undefined;
    if (typeof first?.text !== 'string' || !first.text.startsWith(OAUTH_ATTESTATION)) {
      body['system'] = [attestEntry, ...cur];
    }
  }

  // ---- tool-name sanitisation (reserved `mcp_` prefix, dotted names) ----
  const nameMap = new Map<string, string>();
  if (Array.isArray(body['tools'])) {
    for (const tool of body['tools'] as Array<Record<string, unknown>>) {
      const original = tool['name'];
      if (typeof original === 'string') {
        const sanitized = sanitizeOAuthToolName(original);
        if (sanitized !== original) {
          nameMap.set(sanitized, original);
          tool['name'] = sanitized;
        }
      }
    }
    // tool_choice may pin a sanitized tool — keep it consistent.
    const tc = body['tool_choice'];
    if (tc !== null && typeof tc === 'object' && typeof (tc as Record<string, unknown>)['name'] === 'string') {
      const tcName = (tc as Record<string, unknown>)['name'] as string;
      const sanitized = sanitizeOAuthToolName(tcName);
      if (sanitized !== tcName) {
        nameMap.set(sanitized, tcName);
        (tc as Record<string, unknown>)['name'] = sanitized;
      }
    }
  }
  return nameMap;
}

/** Reverse the sanitized→original map on the response's tool_use blocks. */
function reverseToolNames(res: IRResponse, nameMap: Map<string, string>): IRResponse {
  if (nameMap.size === 0) return res;
  return {
    ...res,
    blocks: res.blocks.map((b) =>
      b.type === 'tool_use' && nameMap.has(b.name) ? { ...b, name: nameMap.get(b.name)! } : b,
    ),
  };
}

// ---------------------------------------------------------------------------
// Shared request preparation (callIR + streamIR)
// ---------------------------------------------------------------------------

interface PreparedCall {
  r: ResolvedRoute;
  /** Exact serialized wire body (sha256'd into the llm_calls row). */
  wireBody: string;
  /** claude-oauth sanitized→original tool-name map (empty otherwise). */
  nameMap: Map<string, string>;
}

/**
 * Resolve route + build the exact wire body for one IR call. Shared verbatim
 * between callIR (stream=false) and streamIR (stream=true — the ONLY body
 * difference is the `stream: true` field, both families). Throws
 * invalid_request LLMPolicyError on unroutable/unbuildable input.
 */
function prepareWireCall(ir: IRRequest, stream: boolean): PreparedCall {
  const r = resolveRoute(ir.alias);
  let nameMap = new Map<string, string>();
  let body: Record<string, unknown>;
  if (r.family === 'anthropic') {
    // egressAnthropic already emits the bare model id for anthropic/
    // claude-oauth prefixes; custom anthropic-shaped providers need the
    // strip applied here (their prefix is not known to the adapter).
    body = egressAnthropic(ir);
    body['model'] = r.modelId;
    // Strip `temperature` for models that deprecated it (ported verbatim
    // from legacy providers.ts): opus-4-8+ and the Claude 5 family 400 with
    // "`temperature` is deprecated for this model"; older models keep it.
    if (
      /^claude-opus-4-(8|9|[1-9][0-9]+)/.test(r.modelId) ||
      /^claude-[a-z]+-5\b/.test(r.modelId)
    ) {
      delete body['temperature'];
    }
    if (stream) body['stream'] = true;
    if (r.provider === 'claude-oauth') nameMap = applyOAuthBodyContract(body);
  } else {
    // egressOpenAI keeps the full provider/model string (verified) — the
    // wire wants the bare id, so strip the prefix HERE, exactly once.
    body = egressOpenAI(ir);
    body['model'] = r.modelId;
    if (stream) {
      body['stream'] = true;
      // Without this, OpenAI-compat streams omit usage entirely and every
      // streamed llm_calls row would log zero tokens — blinding budget/cost
      // accounting. Standard OpenAI spec field; xai/groq/deepseek/ollama
      // accept or ignore it. The trailing usage chunk arrives after
      // finish_reason and is consumed via machine.end() at [DONE].
      body['stream_options'] = { include_usage: true };
    }
  }
  return { r, wireBody: JSON.stringify(body), nameMap };
}

// ---------------------------------------------------------------------------
// callIR
// ---------------------------------------------------------------------------

/**
 * One non-streaming IR call: resolve route → build wire body → policy-wrapped
 * authed fetch → parsed IRResponse. Provider lies (200-garbage, refusals) are
 * RETURNED as stop_reason 'error' + extra; only transport-level failures throw.
 */
export async function callIR(ir: IRRequest, opts: CallIROptions = {}): Promise<IRResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  const traceId = ir.trace_id !== '' ? ir.trace_id : randomUUID();

  // Route + body resolution failures are invalid_request throws; log them too
  // (one row per callIR, success or failure).
  let r: ResolvedRoute;
  let wireBody: string;
  let nameMap: Map<string, string>;
  try {
    ({ r, wireBody, nameMap } = prepareWireCall(ir, false));
  } catch (err) {
    recordCall({
      traceId,
      caller: ir.caller,
      purpose: ir.purpose || 'callIR',
      alias: ir.alias,
      priority: ir.priority,
      irRequest: ir,
      errorClass: err instanceof LLMPolicyError ? err.class : 'invalid_request',
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }

  const record: LLMCallRecord = {
    traceId,
    caller: ir.caller,
    purpose: ir.purpose || 'callIR',
    alias: ir.alias,
    route: r.route,
    priority: ir.priority,
    irRequest: ir,
    wirePayloadSha256: sha256Hex(wireBody),
  };

  try {
    const { value } = await runWithPolicy<{ res: IRResponse; errorClass: LLMErrorClass | null }>({
      route: r.route,
      caller: ir.caller,
      priority: ir.priority,
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
      ...(opts.noRetry === true ? { maxAttempts: 1 } : {}),
      attempt: async (ctx) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(await authHeaders(r)),
        };
        const response = await fetchImpl(r.url, {
          method: 'POST',
          headers,
          body: wireBody,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const cls = classifyHttpError(response.status, text);
          throw new LLMPolicyError(
            `[llm-transport] ${r.route} HTTP ${response.status}: ${text.slice(0, 300)}`,
            { class: cls, status: response.status, route: r.route },
          );
        }

        // 200: parse defensively — non-JSON bodies fall through to the
        // parsers' provider_bug path (they never throw).
        const raw = await response.text().catch(() => '');
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        let res =
          r.family === 'anthropic'
            ? parseAnthropicResponse(json, traceId)
            : parseOpenAIResponse(json, traceId);
        res = reverseToolNames(res, nameMap);
        const errorClass =
          r.family === 'anthropic' ? classifyAnthropicResponse(res) : classifyOpenAIResponse(res);
        // provider_bug / content_filter are RETURNED (stop_reason 'error' +
        // extra set by the parser) — a refusal is not a transport failure.
        return { res, errorClass };
      },
    });

    recordCall({
      ...record,
      irResponse: value.res,
      ...(value.errorClass !== null ? { errorClass: value.errorClass } : {}),
      latencyMs: Date.now() - startedAt,
      tokensIn: value.res.usage.in,
      tokensOut: value.res.usage.out,
      tokensCached: value.res.usage.cached_in,
    });
    return value.res;
  } catch (err) {
    recordCall({
      ...record,
      errorClass: err instanceof LLMPolicyError ? err.class : classifyThrownSafe(err),
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}

/** classifyThrown that can never itself throw (logging is fail-open). */
function classifyThrownSafe(err: unknown): LLMErrorClass {
  try {
    return classifyThrown(err);
  } catch {
    return 'unknown';
  }
}

/** Fail-open llm_calls row — mirrors client.ts recordGatewayCall contract. */
function recordCall(entry: LLMCallRecord): void {
  try {
    recordGatewayCall(entry);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'llm_calls record failed (fail-open)');
  }
}

// ---------------------------------------------------------------------------
// streamIR — SSE byte-stream transport (gw-cutover Phase 1)
// ---------------------------------------------------------------------------

/**
 * Incremental SSE frame parser: bytes → `data:` payload strings.
 * - Frames are separated by a blank line; \r\n, \n and \r line ends accepted.
 * - Comment lines (`: keepalive`) and non-data fields (`event:`, `id:`,
 *   `retry:`) are ignored — Anthropic repeats the event type inside the data
 *   JSON, so the `event:` field carries no extra information.
 * - Multiple `data:` lines in one frame are joined with '\n' (SSE spec).
 * - A trailing '\r' at the end of a chunk is held back until the next chunk
 *   so a \r\n split across chunk boundaries never yields a phantom line.
 */
function createSSEParser(): { feed(chunk: Uint8Array): string[] } {
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines: string[] = [];

  function handleLine(line: string, out: string[]): void {
    if (line === '') {
      // Blank line = end of frame; dispatch accumulated data (if any).
      if (dataLines.length > 0) {
        out.push(dataLines.join('\n'));
        dataLines = [];
      }
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return; // event:/id:/retry: ignored
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }

  return {
    feed(chunk: Uint8Array): string[] {
      buf += decoder.decode(chunk, { stream: true });
      const out: string[] = [];
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf('\n', start);
        const cr = buf.indexOf('\r', start);
        let end: number;
        let next: number;
        if (cr !== -1 && (nl === -1 || cr < nl)) {
          if (cr === buf.length - 1) break; // might be half of a \r\n — wait
          end = cr;
          next = buf[cr + 1] === '\n' ? cr + 2 : cr + 1;
        } else if (nl !== -1) {
          end = nl;
          next = nl + 1;
        } else {
          break; // no complete line yet
        }
        handleLine(buf.slice(start, end), out);
        start = next;
      }
      buf = buf.slice(start);
      return out;
    },
  };
}

/** claude-oauth reverse map applied to yielded tool events (mirrors callIR). */
function reverseEventToolName(ev: IRStreamEvent, nameMap: Map<string, string>): IRStreamEvent {
  if (nameMap.size === 0) return ev;
  if ((ev.type === 'tool_use_start' || ev.type === 'tool_use_end') && nameMap.has(ev.name)) {
    return { ...ev, name: nameMap.get(ev.name)! };
  }
  return ev;
}

/**
 * Rebuild an IRResponse from the yielded event stream so the llm_calls row
 * stores the same full ir_response callIR would have (observability parity).
 */
function createResponseAccumulator(traceId: string): {
  add(ev: IRStreamEvent): void;
  terminal: { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null;
  toIRResponse(): IRResponse;
} {
  const blocks: IRResponse['blocks'] = [];
  const acc = {
    terminal: null as { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null,
    add(ev: IRStreamEvent): void {
      if (ev.type === 'text_delta') {
        const last = blocks[blocks.length - 1];
        if (last !== undefined && last.type === 'text') last.text += ev.text;
        else blocks.push({ type: 'text', text: ev.text });
      } else if (ev.type === 'tool_use_end') {
        blocks.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.type === 'message_end') {
        acc.terminal = { stop_reason: ev.stop_reason, usage: ev.usage };
      }
    },
    toIRResponse(): IRResponse {
      return {
        blocks,
        // Consumer abandoned the stream before the terminal event →
        // stop_reason 'error' on the partial (mirror brain's partial-usage
        // billing philosophy: record what is known, never invent success).
        stop_reason: acc.terminal?.stop_reason ?? 'error',
        usage: acc.terminal?.usage ?? { in: 0, out: 0, cached_in: 0 },
        trace_id: traceId,
      };
    },
  };
  return acc;
}

/** Live state handed from the policy-wrapped attempt to the yield loop. */
interface LiveStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  machine: IRStreamMachine;
  parser: ReturnType<typeof createSSEParser>;
  /** Events emitted during the attempt (first batch, possibly terminal). */
  buffered: IRStreamEvent[];
  /** Reader exhausted during the attempt. */
  readerDone: boolean;
  /** In-band terminal seen ([DONE] / anthropic message_stop / error event). */
  cleanTerminal: boolean;
  /** The terminal message_end came from a truncation flush (RULE 4 audit). */
  truncated: boolean;
}

/** Feed one byte chunk through parser+machine. Mutates `live` bookkeeping. */
function feedChunk(live: LiveStream, chunk: Uint8Array, family: Family): IRStreamEvent[] {
  const out: IRStreamEvent[] = [];
  for (const payload of live.parser.feed(chunk)) {
    if (live.machine.terminated) break; // single-use: never push past terminal
    if (family === 'openai' && payload.trim() === '[DONE]') {
      // OpenAI trailing-usage contract: the transport calls machine.end() at
      // [DONE]; a trailing usage chunk after finish_reason has already
      // emitted the terminal message_end, in which case end() is a no-op.
      live.cleanTerminal = true;
      out.push(...live.machine.end());
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue; // non-JSON data payload — ignore (defensive)
    }
    out.push(...live.machine.push(json));
    if (live.machine.terminated) live.cleanTerminal = true; // in-band terminal
  }
  return out;
}

/**
 * One STREAMING IR call: same route/auth/body construction as callIR plus
 * `stream: true`, yielding typed IRStreamEvents as they arrive.
 *
 * - RULE 4: runWithPolicy may retry ONLY before the first machine event
 *   (ctx.markFirstToken fires at the first emission; each attempt gets a
 *   fresh machine). After the first token, any transport/stream failure is
 *   surfaced through the machine's fail() path — stream_error followed by a
 *   terminal message_end {stop_reason:'error'} — never a re-request.
 * - Truncation (socket ends without [DONE]/message_stop) drives the machine's
 *   documented terminal flush via end(); the llm_calls row gets error_class
 *   'provider_bug'.
 * - Exactly ONE llm_calls row per call (fail-open), written at the terminal
 *   event — or, if the consumer breaks out early, from the generator's
 *   finally with whatever is known (the underlying fetch is aborted).
 */
export async function* streamIR(
  ir: IRRequest,
  opts: CallIROptions = {},
): AsyncGenerator<IRStreamEvent, void, undefined> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  const traceId = ir.trace_id !== '' ? ir.trace_id : randomUUID();

  let r: ResolvedRoute;
  let wireBody: string;
  let nameMap: Map<string, string>;
  try {
    ({ r, wireBody, nameMap } = prepareWireCall(ir, true));
  } catch (err) {
    recordCall({
      traceId,
      caller: ir.caller,
      purpose: ir.purpose || 'streamIR',
      alias: ir.alias,
      priority: ir.priority,
      irRequest: ir,
      errorClass: err instanceof LLMPolicyError ? err.class : 'invalid_request',
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }

  const baseRecord: LLMCallRecord = {
    traceId,
    caller: ir.caller,
    purpose: ir.purpose || 'streamIR',
    alias: ir.alias,
    route: r.route,
    priority: ir.priority,
    irRequest: ir,
    wirePayloadSha256: sha256Hex(wireBody),
  };

  let recorded = false;
  let ttftMs: number | undefined;
  const acc = createResponseAccumulator(traceId);
  const writeRow = (fields: Partial<LLMCallRecord>): void => {
    if (recorded) return;
    recorded = true;
    recordCall({
      ...baseRecord,
      latencyMs: Date.now() - startedAt,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...fields,
    });
  };

  // Aborts the underlying fetch when the consumer breaks out early.
  const controller = new AbortController();

  let live: LiveStream;
  try {
    ({ value: live } = await runWithPolicy<LiveStream>({
      route: r.route,
      caller: ir.caller,
      priority: ir.priority,
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
      ...(opts.noRetry === true ? { maxAttempts: 1 } : {}),
      attempt: async (ctx) => {
        // Fresh single-use machine + parser per attempt (RULE 4: a retried
        // attempt must never see a machine that already consumed events).
        const st: LiveStream = {
          reader: undefined as unknown as ReadableStreamDefaultReader<Uint8Array>,
          machine: createSSEMachine(r.family),
          parser: createSSEParser(),
          buffered: [],
          readerDone: false,
          cleanTerminal: false,
          truncated: false,
        };
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(await authHeaders(r)),
        };
        const signal =
          ctx.signal !== undefined ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
        const response = await fetchImpl(r.url, {
          method: 'POST',
          headers,
          body: wireBody,
          signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const cls = classifyHttpError(response.status, text);
          throw new LLMPolicyError(
            `[llm-transport] ${r.route} HTTP ${response.status}: ${text.slice(0, 300)}`,
            { class: cls, status: response.status, route: r.route },
          );
        }
        if (response.body === null) {
          throw new LLMPolicyError(`[llm-transport] ${r.route}: 200 response with no body stream`, {
            class: 'provider_bug',
            route: r.route,
            retryable: false,
          });
        }
        st.reader = response.body.getReader();

        // Read until the machine emits its FIRST event(s) — errors thrown in
        // this window are pre-first-token and therefore policy-retryable.
        while (st.buffered.length === 0) {
          const { done, value } = await st.reader.read();
          if (done) {
            st.readerDone = true;
            if (!st.machine.terminated) {
              // Stream closed without a single event or terminal — truncation
              // flush per machine contract.
              st.truncated = !st.cleanTerminal;
              st.buffered.push(...st.machine.end());
            }
            break;
          }
          st.buffered.push(...feedChunk(st, value, r.family));
          if (st.machine.terminated) break;
        }
        if (st.buffered.length > 0) {
          ctx.markFirstToken(); // RULE 4: no retries past this point
          ttftMs = Date.now() - startedAt;
        }
        return st;
      },
    }));
  } catch (err) {
    // Pre-first-token failure with retries exhausted — mirror callIR.
    writeRow({ errorClass: err instanceof LLMPolicyError ? err.class : classifyThrownSafe(err) });
    throw err;
  }

  let failure: unknown;
  let streamErrorMsg: string | undefined;

  const finalize = (ev: IRStreamEvent): IRStreamEvent => {
    const out = reverseEventToolName(ev, nameMap);
    if (out.type === 'stream_error') streamErrorMsg = out.error;
    acc.add(out);
    return out;
  };

  try {
    for (const ev of live.buffered) yield finalize(ev);

    while (!live.machine.terminated && !live.readerDone) {
      let events: IRStreamEvent[];
      try {
        const { done, value } = await live.reader.read();
        if (done) {
          live.readerDone = true;
          if (live.machine.terminated) break;
          // Abrupt end without a terminal event → truncation flush.
          live.truncated = !live.cleanTerminal;
          events = live.machine.end();
        } else {
          events = feedChunk(live, value, r.family);
        }
      } catch (err) {
        // Post-first-token transport error: NEVER re-request, never hang —
        // surface via the machine's fail() path and stop (RULE 4).
        failure = err;
        events = live.machine.terminated
          ? []
          : live.machine.fail(err instanceof Error ? err.message : String(err));
      }
      for (const ev of events) yield finalize(ev);
    }

    // Terminal reached (or stream exhausted) — write the ONE llm_calls row.
    const terminal = acc.terminal;
    let errorClass: LLMErrorClass | undefined;
    if (terminal !== null && terminal.stop_reason === 'error') {
      errorClass =
        failure !== undefined
          ? classifyThrownSafe(failure)
          : classifyThrownSafe(new Error(streamErrorMsg ?? 'stream terminated with error'));
    } else if (live.truncated) {
      // Provider closed its SSE stream without the documented terminal event.
      errorClass = 'provider_bug';
    }
    writeRow({
      irResponse: acc.toIRResponse(),
      ...(errorClass !== undefined ? { errorClass } : {}),
      ...(terminal !== null
        ? {
            tokensIn: terminal.usage.in,
            tokensOut: terminal.usage.out,
            tokensCached: terminal.usage.cached_in,
          }
        : {}),
    });
  } finally {
    // Consumer break / early return: abort the underlying fetch and still
    // write the row with what's known. NEVER throw from this path.
    try {
      controller.abort();
    } catch {
      /* abort must never mask the consumer's control flow */
    }
    try {
      live.reader.cancel().catch(() => {
        /* underlying stream already errored/aborted — fine */
      });
    } catch {
      /* reader already released */
    }
    writeRow({ irResponse: acc.toIRResponse() });
  }
}
