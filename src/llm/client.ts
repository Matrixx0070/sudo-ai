/**
 * @file client.ts
 * @description The LLM choke point. Every outbound LLM-family call in the
 * codebase flows through this module: chat (`chatIR`), embeddings (`embed`),
 * vision (`visionIR`) and — for LLM-adjacent modalities that are not yet IR
 * (TTS/STT/image-gen/liveness probes) — the guarded raw transport `llmFetch`.
 *
 * Configuration comes from exactly two env vars:
 *   LLM_BASE_URL  — OpenAI-compatible gateway base URL (no trailing slash)
 *   LLM_API_KEY   — the ONE token app code holds
 *
 * Migration switch:
 *   LLM_DIRECT_FALLBACK=1 (DEFAULT during migration) — chat resolves through
 *   the legacy multi-provider layer (src/llm/legacy/providers.ts) exactly as
 *   before; embeddings/vision hit their provider URL directly with the
 *   provider key. Set to 0 after cutover: everything goes to LLM_BASE_URL.
 *
 * Every call MUST carry `caller` (e.g. 'agent-loop', 'swarm:<role>',
 * 'cognitive-stream', 'cron:<job>', 'verifier', 'rag', 'browser-vision') and
 * `purpose` (short free text). In dev/test a missing caller throws; in
 * production it is logged and coerced to 'unknown' — a user request is never
 * blocked by telemetry hygiene (fail-open rule).
 */

import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/shared/logger.js';
import { resolveAlias } from './aliases.js';
import { classifyThrown } from './errors.js';
import { getGatewayCallLog, sha256Hex, type LLMCallRecord } from './logging.js';
import { OPENAI_EMBEDDINGS_URL, PROVIDER_BASE_URLS, PROVIDER_HOSTNAMES } from './endpoints.js';

const log = createLogger('llm-client');

// ---------------------------------------------------------------------------
// Gateway call-log wiring (Phase 5) — FAIL-OPEN by contract
// ---------------------------------------------------------------------------

let _gatewayLogWarned = false;

/**
 * Fire-and-forget GatewayCallLog row. Gated by SUDO_GATEWAY_LOG (default ON,
 * '0' disables) and fully try/caught: a logging bug can never break a call.
 * Skipped under vitest unless SUDO_GATEWAY_LOG_TEST=1 (no test-DB pollution).
 * Exported so transport.ts shares the exact same kill-switch idiom.
 */
export function recordGatewayCall(entry: LLMCallRecord): void {
  try {
    if (process.env['SUDO_GATEWAY_LOG'] === '0') return;
    if (process.env['VITEST'] && process.env['SUDO_GATEWAY_LOG_TEST'] !== '1') return;
    getGatewayCallLog().record(entry);
  } catch (err) {
    if (!_gatewayLogWarned) {
      _gatewayLogWarned = true;
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gateway call-log record failed (fail-open, warn once)');
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function gatewayBaseUrl(): string | null {
  const v = process.env['LLM_BASE_URL']?.trim();
  return v ? v.replace(/\/+$/, '') : null;
}

function gatewayKey(): string | null {
  return process.env['LLM_API_KEY']?.trim() || null;
}

/** Default ON during migration (rule: legacy failover behind LLM_DIRECT_FALLBACK=1). */
export function directFallbackEnabled(): boolean {
  return process.env['LLM_DIRECT_FALLBACK'] !== '0';
}

// ---------------------------------------------------------------------------
// Call metadata (mandatory)
// ---------------------------------------------------------------------------

export interface CallMeta {
  /** Who is calling: 'agent-loop', 'swarm:<role>', 'cognitive-stream', 'cron:<job>', 'verifier', 'rag', ... */
  caller: string;
  /** Short free text: what this call is for. */
  purpose: string;
}

function requireMeta(meta: CallMeta | undefined, fn: string): CallMeta {
  if (meta?.caller && meta.caller.trim() !== '') {
    return { caller: meta.caller, purpose: meta.purpose ?? '' };
  }
  const msg = `[llm-client] ${fn}() called without caller — every LLM call must identify its caller`;
  if (process.env['NODE_ENV'] === 'production') {
    log.error({ fn }, msg);
    return { caller: 'unknown', purpose: meta?.purpose ?? '' };
  }
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Provider keys — the ONLY place app code may resolve a provider API key.
// ---------------------------------------------------------------------------

const PROVIDER_KEY_ENVS = {
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  'xai-voice': 'XAI_VOICE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
} as const;

export type ProviderKeyName = keyof typeof PROVIDER_KEY_ENVS;

/**
 * Resolve a provider API key for a direct (legacy-fallback) call. Returns
 * null when unset. Outside `src/llm/` nothing reads provider key envs.
 */
export function getProviderApiKey(name: ProviderKeyName): string | null {
  return process.env[PROVIDER_KEY_ENVS[name]]?.trim() || null;
}

// ---------------------------------------------------------------------------
// llmFetch — guarded raw transport for LLM-adjacent modalities
// ---------------------------------------------------------------------------

/**
 * Raw HTTP escape hatch for modalities that do not have an IR yet (TTS, STT,
 * image generation, /v1/models liveness probes). Enforces that the target is
 * either the configured gateway or a known provider host, and stamps
 * caller/purpose into the debug log so Phase 5 can account for every call.
 */
export async function llmFetch(url: string, init: RequestInit, meta: CallMeta): Promise<Response> {
  const m = requireMeta(meta, 'llmFetch');
  const host = new URL(url).hostname;
  const gw = gatewayBaseUrl();
  const allowed = (gw && host === new URL(gw).hostname) || PROVIDER_HOSTNAMES.includes(host);
  if (!allowed) {
    throw new Error(`[llm-client] llmFetch refused non-provider host: ${host}`);
  }
  log.debug({ caller: m.caller, purpose: m.purpose, host }, 'llmFetch');
  return fetch(url, init);
}

// ---------------------------------------------------------------------------
// embed — the embeddings choke point (hybrid RAG, 1536-dim)
// ---------------------------------------------------------------------------

/** True when an embeddings route exists (gateway configured or OpenAI key present). */
export function embeddingsAvailable(): boolean {
  return Boolean(gatewayBaseUrl() ?? getProviderApiKey('openai'));
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * One embedding attempt (no retry — callers like EmbeddingService own their
 * retry/circuit policy). Throws an Error with a `.status` property on a
 * non-2xx response so callers can classify 429/5xx; network errors rethrow.
 */
export async function embed(
  texts: string[],
  meta: CallMeta,
  opts: { model?: string } = {},
): Promise<EmbedResult> {
  const m = requireMeta(meta, 'embed');
  const model = resolveAlias(opts.model ?? 'sudo/embed').replace(/^openai\//, '');
  const gw = gatewayBaseUrl();
  const url = gw ? `${gw}/embeddings` : OPENAI_EMBEDDINGS_URL;
  const key = gw ? gatewayKey() : getProviderApiKey('openai');
  if (!key) throw new Error('[llm-client] embed: no API key configured');

  // Phase 5 gateway log. ir_request stores {input_count, model} ONLY —
  // embedding inputs are bulky and private, never persisted.
  const traceId = randomUUID();
  const startedAt = Date.now();
  const baseRecord: LLMCallRecord = {
    traceId,
    caller: m.caller,
    purpose: m.purpose || 'embed',
    alias: opts.model ?? 'sudo/embed',
    route: gw ? 'gateway:embeddings' : 'openai:embeddings',
    irRequest: { input_count: texts.length, model },
  };

  log.debug({ caller: m.caller, purpose: m.purpose, count: texts.length, model }, 'embed');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(
        `[llm-client] embed failed: ${response.status} ${body.slice(0, 300)}`,
      ) as Error & { status: number };
      err.status = response.status;
      throw err;
    }

    const json = (await response.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    recordGatewayCall({
      ...baseRecord,
      irResponse: { embedding_count: sorted.length, model: json.model ?? model },
      latencyMs: Date.now() - startedAt,
      ...(json.usage?.prompt_tokens !== undefined ? { tokensIn: json.usage.prompt_tokens } : {}),
    });
    return { embeddings: sorted.map((d) => d.embedding), model: json.model ?? model, usage: json.usage };
  } catch (err) {
    recordGatewayCall({ ...baseRecord, errorClass: classifyThrown(err), latencyMs: Date.now() - startedAt });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// chatIR — the chat choke point (Phase 1: thin; Phase 2 brings the zod IR)
// ---------------------------------------------------------------------------

export interface ChatIRRequestLite {
  /** Model alias (sudo/*) or, during migration, a concrete provider/model string. */
  alias: string;
  caller: string;
  purpose: string;
  system?: string;
  /** Loose message shape in Phase 1; Phase 2 replaces this with the zod IR. */
  messages: Array<{ role: string; content: unknown }>;
  maxTokens?: number;
  temperature?: number;
  priority?: 'user' | 'background';
  trace_id?: string;
}

export interface ChatIRResponseLite {
  text: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage: { in: number; out: number; cached_in: number };
  trace_id?: string;
}

/**
 * Chat through the choke point. Gateway route when LLM_BASE_URL is set and
 * direct fallback is off; otherwise the legacy provider layer (identical
 * behavior to pre-refactor). NOTE (Phase 1): the user-facing agent loop still
 * calls Brain.call directly — Brain is migrated onto this path in Phases 2–3
 * behind LLM_SHADOW. New code must use chatIR, never providers directly.
 */
export async function chatIR(req: ChatIRRequestLite): Promise<ChatIRResponseLite> {
  const m = requireMeta(req, 'chatIR');
  const model = resolveAlias(req.alias);
  const gw = gatewayBaseUrl();

  // Phase 5 gateway log. ChatIRRequestLite IS the IR-shaped request — store it
  // whole (logging.ts redacts before persist); the response summary is stored
  // whole too. wire_payload_sha256 is set only on the gateway route, where the
  // exact final wire body is constructed here.
  const traceId = req.trace_id ?? randomUUID();
  const startedAt = Date.now();
  const baseRecord: LLMCallRecord = {
    traceId,
    caller: m.caller,
    purpose: m.purpose || 'chatIR',
    alias: req.alias,
    ...(req.priority !== undefined ? { priority: req.priority } : {}),
    irRequest: req,
  };

  if (gw && !directFallbackEnabled()) {
    const key = gatewayKey();
    const wireBody = JSON.stringify({
      model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages,
      ],
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });
    try {
      const response = await fetch(`${gw}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          'x-sudo-caller': m.caller,
          'x-sudo-purpose': m.purpose.slice(0, 200),
        },
        body: wireBody,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`[llm-client] gateway chat failed: ${response.status} ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as {
        choices: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      const out: ChatIRResponseLite = {
        text: choice?.message?.content ?? '',
        stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
        usage: {
          in: json.usage?.prompt_tokens ?? 0,
          out: json.usage?.completion_tokens ?? 0,
          cached_in: 0,
        },
        trace_id: traceId,
      };
      recordGatewayCall({
        ...baseRecord,
        route: 'gateway:chat/completions',
        irResponse: out,
        wirePayloadSha256: sha256Hex(wireBody),
        latencyMs: Date.now() - startedAt,
        tokensIn: out.usage.in,
        tokensOut: out.usage.out,
        tokensCached: out.usage.cached_in,
      });
      return out;
    } catch (err) {
      recordGatewayCall({
        ...baseRecord,
        route: 'gateway:chat/completions',
        wirePayloadSha256: sha256Hex(wireBody),
        errorClass: classifyThrown(err),
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  // Legacy direct path (default during migration) — same provider layer as before.
  const { getModel } = await import('./legacy/providers.js');
  log.debug({ caller: m.caller, purpose: m.purpose, model }, 'chatIR (direct fallback)');
  try {
    const result = await generateText({
      model: getModel(model) as Parameters<typeof generateText>[0]['model'],
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages as NonNullable<Parameters<typeof generateText>[0]['messages']>,
      ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });
    const out: ChatIRResponseLite = {
      text: result.text,
      stop_reason:
        result.finishReason === 'length'
          ? 'max_tokens'
          : result.finishReason === 'tool-calls'
            ? 'tool_use'
            : result.finishReason === 'error'
              ? 'error'
              : 'end_turn',
      usage: {
        in: result.usage?.inputTokens ?? 0,
        out: result.usage?.outputTokens ?? 0,
        cached_in: result.usage?.cachedInputTokens ?? 0,
      },
      trace_id: traceId,
    };
    recordGatewayCall({
      ...baseRecord,
      route: `legacy:${model.split('/')[0] ?? 'unknown'}`,
      irResponse: out,
      latencyMs: Date.now() - startedAt,
      tokensIn: out.usage.in,
      tokensOut: out.usage.out,
      tokensCached: out.usage.cached_in,
    });
    return out;
  } catch (err) {
    recordGatewayCall({
      ...baseRecord,
      route: `legacy:${model.split('/')[0] ?? 'unknown'}`,
      errorClass: classifyThrown(err),
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// visionIR — the vision choke point (image input → text)
// ---------------------------------------------------------------------------

export interface VisionIRRequestLite {
  caller: string;
  purpose: string;
  /** data: URL or https URL of the image. */
  imageUrl: string;
  prompt: string;
  alias?: string;
  maxTokens?: number;
}

/**
 * Vision through the choke point. Gateway route when configured (and direct
 * fallback off); otherwise direct xAI → OpenAI fallback, mirroring the legacy
 * browser-vision behavior byte-for-byte on the request shape.
 */
export async function visionIR(req: VisionIRRequestLite): Promise<{ text: string }> {
  const m = requireMeta(req, 'visionIR');
  const gw = gatewayBaseUrl();

  const body = (model: string) =>
    JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: req.prompt },
            { type: 'image_url', image_url: { url: req.imageUrl } },
          ],
        },
      ],
      max_tokens: req.maxTokens ?? 1024,
    });

  const attempt = async (url: string, key: string, model: string): Promise<string> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: body(model),
      // Per-route cap so a hung provider can never hang the calling tool
      // (matches the legacy browser-vision 60s per-provider timeout).
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`[llm-client] vision ${model} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    const json = (await response.json()) as { choices: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  };

  log.debug({ caller: m.caller, purpose: m.purpose }, 'visionIR');

  // Phase 5 gateway log. ir_request stores {prompt_chars, model} ONLY —
  // image data (data: URLs can be megabytes) is NEVER persisted.
  const traceId = randomUUID();
  const startedAt = Date.now();
  const baseRecord: LLMCallRecord = {
    traceId,
    caller: m.caller,
    purpose: m.purpose || 'visionIR',
    alias: req.alias ?? 'sudo/vision',
    irRequest: { prompt_chars: req.prompt.length, model: resolveAlias(req.alias ?? 'sudo/vision') },
  };
  const recordVisionSuccess = (route: string, text: string): void => {
    recordGatewayCall({
      ...baseRecord,
      route,
      irResponse: { text_chars: text.length },
      latencyMs: Date.now() - startedAt,
    });
  };

  if (gw && !directFallbackEnabled()) {
    const model = resolveAlias(req.alias ?? 'sudo/vision');
    try {
      const text = await attempt(`${gw}/chat/completions`, gatewayKey() ?? '', model);
      recordVisionSuccess('gateway:chat/completions', text);
      return { text };
    } catch (err) {
      recordGatewayCall({ ...baseRecord, route: 'gateway:chat/completions', errorClass: classifyThrown(err), latencyMs: Date.now() - startedAt });
      throw err;
    }
  }

  const errors: string[] = [];
  const xaiKey = getProviderApiKey('xai');
  if (xaiKey) {
    try {
      const text = await attempt(
        `${PROVIDER_BASE_URLS.xai}/chat/completions`,
        xaiKey,
        resolveAlias(req.alias ?? 'sudo/vision').replace(/^xai\//, ''),
      );
      recordVisionSuccess('legacy:xai', text);
      return { text };
    } catch (err) {
      errors.push(String(err));
    }
  }
  const openaiKey = getProviderApiKey('openai');
  if (openaiKey) {
    try {
      const text = await attempt(`${PROVIDER_BASE_URLS.openai}/chat/completions`, openaiKey, 'gpt-4o');
      recordVisionSuccess('legacy:openai', text);
      return { text };
    } catch (err) {
      errors.push(String(err));
    }
  }
  const allFailed = new Error(`[llm-client] visionIR: all routes failed: ${errors.join(' | ') || 'no API keys configured'}`);
  recordGatewayCall({ ...baseRecord, route: 'legacy:vision-fallback', errorClass: classifyThrown(allFailed), latencyMs: Date.now() - startedAt });
  throw allFailed;
}
