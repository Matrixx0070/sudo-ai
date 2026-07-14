/**
 * @file transport.ts
 * @description In-process IR transport (gw-cutover Phase 0, non-streaming):
 * `callIR(ir)` = resolveAlias → provider family → egress adapter → authed
 * fetch → parse → IRResponse, the whole attempt wrapped in `runWithPolicy`.
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
import type { IRRequest, IRResponse } from '../../shared-types/ir/v1.js';
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
  let nameMap = new Map<string, string>();
  try {
    r = resolveRoute(ir.alias);
    if (r.family === 'anthropic') {
      // egressAnthropic already emits the bare model id for anthropic/
      // claude-oauth prefixes; custom anthropic-shaped providers need the
      // strip applied here (their prefix is not known to the adapter).
      const body = egressAnthropic(ir);
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
      if (r.provider === 'claude-oauth') nameMap = applyOAuthBodyContract(body);
      wireBody = JSON.stringify(body);
    } else {
      // egressOpenAI keeps the full provider/model string (verified) — the
      // wire wants the bare id, so strip the prefix HERE, exactly once.
      const body = egressOpenAI(ir);
      body['model'] = r.modelId;
      wireBody = JSON.stringify(body);
    }
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
