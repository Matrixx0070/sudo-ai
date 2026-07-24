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
 * - `xai-oauth/` → xAI Responses-style endpoint (family 'xai-responses',
 *   XAI_RESPONSES_URL): subscription OAuth Grok. Bearer from
 *   getXaiOAuthManager().getAccessToken() (Phase-1 manager owns refresh),
 *   `x-grok-conv-id` header from ir.extra.conv_id ?? trace_id (prompt-cache
 *   routing), personalOnly guard (ir.extra.untrusted === true → refused).
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
 * Legacy-only request repairs (orphan tool_result strip, empty-text strip)
 * are deliberately NOT ported here — brainRequestToIR (shadow.ts) strips those
 * malformations before the IR ever reaches this transport. Thinking-budget
 * injection (legacy providers.ts section 1c) IS ported: prepareWireCall's
 * anthropic branch reuses resolveThinkingBudget so opus-4-8+ bodies get the
 * same {thinking, max_tokens} the legacy interceptor produces.
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
import { resolveAlias, modelGenerationOf } from './aliases.js';
import { PROVIDER_BASE_URLS, XAI_RESPONSES_URL, XAI_CLI_PROXY_RESPONSES_URL } from './endpoints.js';
import { getProviderApiKey, recordGatewayCall, type ProviderKeyName } from './client.js';
import { egressAnthropic, parseAnthropicResponse } from './adapters/egress-anthropic.js';
import { egressOpenAI, parseOpenAIResponse } from './adapters/egress-openai.js';
import {
  egressXaiResponses,
  parseXaiResponsesResponse,
  createXaiResponsesSSEMachine,
} from './adapters/egress-xai-responses.js';
import {
  classifyHttpError,
  classifyThrown,
  classifyAnthropicResponse,
  classifyOpenAIResponse,
  LLMPolicyError,
  type LLMErrorClass,
} from './errors.js';
import { runWithPolicy, recordSpend } from './policy.js';
import { estimateCostUsd } from './limits.js';
import {
  streamIR as createSSEMachine,
  type IRStreamEvent,
  type IRStreamMachine,
} from './adapters/stream.js';
import { sha256Hex, type LLMCallRecord } from './logging.js';
import { sanitizeOAuthToolName } from '../core/brain/tool-schema-compat.js';
import { resolveThinkingBudget } from '../core/brain/thinking-inject.js';
import { getCustomProviderWireConfig } from './custom-providers.js';
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

/**
 * GX1: default grok-cli client version the subscription proxy requires. The
 * proxy returns HTTP 426 "Grok CLI version (none) is outdated" without a
 * version header ≥ 0.1.202; env-tunable so a future proxy bump is config-only.
 */
const GROK_CLI_DEFAULT_VERSION = '0.2.22';

/**
 * GX1: is the xai-oauth subscription-proxy path enabled? Default ON — the old
 * api.x.ai/v1/responses route billed the metered developer API instead of the
 * user's Grok seat (a billing bug), so the corrected seat-covered path is the
 * safe default. Set SUDO_XAI_OAUTH_SUBSCRIPTION=0 (or false/off/no) to fall
 * back to the legacy metered endpoint.
 */
/**
 * Hard money guard: refuse EVERY xai / xai-oauth text-lane call when
 * SUDO_XAI_TEXT_BLOCK=1. Added 2026-07-24 after console.x.ai proved the
 * cli-chat-proxy "seat" lane bills real API credits ("Grok Build" ~$8.42 in
 * ~2.5h of grok-4.5 brain traffic; credit balance $0 → month-end invoice).
 * Default OFF (unset) so tests/other deployments are unaffected; prod sets it
 * in config/.env. SSO web-session lanes (media/voice/embeddings/rag) are
 * cookie-based, never touch this transport, and remain available.
 */
function xaiTextBlocked(): boolean {
  const v = process.env['SUDO_XAI_TEXT_BLOCK']?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function xaiSubscriptionProxyEnabled(): boolean {
  const v = process.env['SUDO_XAI_OAUTH_SUBSCRIPTION'];
  if (v === undefined) return true;
  const s = v.trim().toLowerCase();
  if (s === '') return true;
  return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/** GX1: resolved grok-cli version for the proxy version + User-Agent headers. */
function grokCliVersion(): string {
  const v = process.env['SUDO_GROK_CLI_VERSION']?.trim();
  return v !== undefined && v !== '' ? v : GROK_CLI_DEFAULT_VERSION;
}

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
  /**
   * streamIR only: called from the generator's finally with the machine's
   * last-known usage snapshot (anthropic message_start already carries
   * input_tokens), so a consumer that breaks out early can still bill the
   * partial usage. Invoked exactly once, before the generator settles; a
   * throwing observer is swallowed (billing hooks must never break cleanup).
   */
  onPartialUsage?: (usage: IRUsage) => void;
  /**
   * Per-call API-key override for env-key providers (brain's auth-profile
   * rotation port — F97). Ignored for claude-oauth / xai-oauth, whose managers
   * own the credential. anthropic-family overrides ship as x-api-key; the
   * OpenAI-compatible family as Bearer.
   */
  apiKeyOverride?: string;
  /**
   * Overall deadline for one buffered callIR attempt (fetch + body read), in
   * ms. Default SUDO_LLM_CALL_TIMEOUT_MS or 600000 (10 min). F97: the legacy
   * provider layer bounded stalls with a headers timer + body-idle guard;
   * this is the buffered path's replacement — an abort classifies as
   * 'timeout' so brain's failover advances instead of hanging a turn forever.
   * streamIR is NOT covered (its consumer observes progress per chunk).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

type Family = 'anthropic' | 'openai' | 'xai-responses';

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
  /** G-MODELGEN: coarse family+major-version lineage token (F64 succession). */
  modelGeneration: string;
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
  const modelGeneration = modelGenerationOf(resolved);

  if ((provider === 'xai' || provider === 'xai-oauth') && xaiTextBlocked()) {
    throw invalidRequest(
      `xai text lane blocked (SUDO_XAI_TEXT_BLOCK=1): cli-chat-proxy bills API credits ` +
        `(console.x.ai proof 2026-07-24) — refused "${resolved}". Free grok stays available ` +
        `via the SSO web-session lanes (media/voice/embeddings/rag).`,
    );
  }

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
      modelGeneration,
    };
  }

  if (provider === 'xai-oauth') {
    // Subscription OAuth Grok rides the Responses-style endpoint. GX1: the
    // seat-covered Grok CLI proxy (default) instead of the metered developer
    // API — same OAuth token, different host + required grok-cli headers
    // (attached in prepareWireCall). Distinct route key so an oauth outage
    // never opens the API-key xai breaker (mirrors anthropic / claude-oauth).
    return {
      family: 'xai-responses',
      provider,
      modelId,
      url: xaiSubscriptionProxyEnabled() ? XAI_CLI_PROXY_RESPONSES_URL : XAI_RESPONSES_URL,
      route: 'xai-oauth:responses',
      modelGeneration,
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
          modelGeneration,
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
    modelGeneration,
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
async function authHeaders(r: ResolvedRoute, apiKeyOverride?: string): Promise<Record<string, string>> {
  if (r.provider === 'claude-oauth') {
    const { getClaudeOAuthManager } = await import('./claude-oauth-manager.js');
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

  if (r.provider === 'xai-oauth') {
    // Phase-1 manager owns refresh discipline (cross-process lock + in-process
    // single-flight; xAI ROTATES the refresh token) — NEVER a second refresher.
    const { getXaiOAuthManager, XaiOAuthReloginRequiredError } = await import('./xai-oauth-manager.js');
    let token: string | null;
    try {
      token = await getXaiOAuthManager().getAccessToken();
    } catch (err) {
      if (err instanceof XaiOAuthReloginRequiredError) {
        // Dead refresh token — permanent until the operator re-authenticates.
        throw new LLMPolicyError(
          '[llm-transport] xai-oauth: refresh token invalid — run `sudo-ai xai-oauth login`',
          { class: 'auth', retryable: false, route: r.route, cause: err },
        );
      }
      throw err;
    }
    if (token === null) {
      // Never logged in: no store on disk. Classified 'auth' (not
      // invalid_request) — the request is well-formed; the credential is
      // absent, same class as an expired login, and failover treats both alike.
      throw new LLMPolicyError(
        '[llm-transport] xai-oauth: not connected — run `sudo-ai xai-oauth login`',
        { class: 'auth', retryable: false, route: r.route },
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  // F97 rotation port: an explicit per-call key outranks env/wire-config keys.
  // Never applies to the oauth managers above (they returned already).
  if (apiKeyOverride !== undefined) {
    return r.family === 'anthropic'
      ? { 'x-api-key': apiKeyOverride, 'anthropic-version': ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${apiKeyOverride}` };
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
  /** Route-specific request headers beyond auth (e.g. x-grok-conv-id). */
  extraHeaders: Record<string, string>;
}

/**
 * Resolve route + build the exact wire body for one IR call. Shared verbatim
 * between callIR (stream=false) and streamIR (stream=true — the ONLY body
 * difference is the `stream: true` field, all families). Throws
 * invalid_request LLMPolicyError on unroutable/unbuildable input.
 */
function prepareWireCall(ir: IRRequest, stream: boolean, traceId: string): PreparedCall {
  const r = resolveRoute(ir.alias);

  // personalOnly hard rule: xai-oauth is the OWNER's subscription — any IR
  // tagged untrusted (non-owner ingress: hooks/gateway/community) is refused
  // outright. First line of defense; upstream isOwner gating (hook/webhook
  // tool allowlists never expose model routing) is the second.
  if (r.provider === 'xai-oauth' && ir.extra?.['untrusted'] === true) {
    throw invalidRequest('xai-oauth is personalOnly — refused for untrusted caller', r.route);
  }

  const extraHeaders: Record<string, string> = {};
  let nameMap = new Map<string, string>();
  let body: Record<string, unknown>;
  if (r.family === 'xai-responses') {
    body = egressXaiResponses(ir);
    body['model'] = r.modelId; // strip the xai-oauth/ prefix, exactly once
    if (stream) body['stream'] = true;
    // Prompt caching routes on the conversation id header (operator gotcha 4).
    const convId = ir.extra?.['conv_id'];
    extraHeaders['x-grok-conv-id'] =
      typeof convId === 'string' && convId !== '' ? convId : traceId;
    // GX1: the Grok CLI subscription proxy requires these grok-cli client
    // headers (Authorization Bearer is added by authHeaders; Content-Type by
    // the attempt). Without x-grok-client-version the proxy 426s. model-override
    // pins the request's resolved model id (proxy serves grok-build /
    // grok-composer-2.5-fast). Gated with the URL choice so the legacy metered
    // path (flag OFF) sends no proxy-only headers.
    if (xaiSubscriptionProxyEnabled()) {
      const version = grokCliVersion();
      extraHeaders['x-grok-client-version'] = version;
      extraHeaders['x-grok-client-identifier'] = 'grok-shell';
      extraHeaders['x-grok-model-override'] = r.modelId;
      extraHeaders['User-Agent'] = `grok/${version}`;
    }
  } else if (r.family === 'anthropic') {
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
    // Extended-thinking injection for opus-4-8+ (ported verbatim from legacy
    // providers.ts section 1c). Only when the body carries no explicit
    // `thinking` (a future ir.extra passthrough must stay untouched).
    // resolveThinkingBudget owns ALL budget/clamp math — including the
    // SUDO_THINKING_DISABLE kill-switch, SUDO_THINKING_BUDGET override, and
    // the SUDO_THINKING_MODEL_MAX ceiling — and bumps max_tokens so
    // budget_tokens < max_tokens (Anthropic 400s otherwise).
    if (typeof body['model'] === 'string' && body['thinking'] === undefined) {
      const tb = resolveThinkingBudget(
        body['model'],
        typeof body['max_tokens'] === 'number' ? body['max_tokens'] : 0,
        {
          disable: process.env['SUDO_THINKING_DISABLE'],
          budget: process.env['SUDO_THINKING_BUDGET'],
          modelMax: process.env['SUDO_THINKING_MODEL_MAX'],
        },
      );
      if (tb) {
        body['thinking'] = { type: 'enabled', budget_tokens: tb.budgetTokens };
        body['max_tokens'] = tb.maxTokens;
      }
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
  return { r, wireBody: JSON.stringify(body), nameMap, extraHeaders };
}

/**
 * Non-2xx HTTP → LLMPolicyError, with xai-oauth specifics layered on top of
 * classifyHttpError: 401 → 'auth' + re-login hint; 403 → 'auth' +
 * extra.tier_gated=true (subscription tier not allowlisted for OAuth
 * inference — the Phase-0 probe's documented gate). Content-filter sniffs
 * still win (a refusal is never a credential problem). 429 keeps its
 * rate_limited class — policy's retry-after handling applies unchanged.
 */
function httpPolicyError(r: ResolvedRoute, status: number, text: string): LLMPolicyError {
  let cls = classifyHttpError(status, text);
  let hint = '';
  let extra: Record<string, unknown> | undefined;
  if (r.provider === 'xai-oauth' && cls !== 'content_filter') {
    if (status === 401) {
      cls = 'auth';
      hint = ' — xai-oauth token rejected; re-login: `sudo-ai xai-oauth login`';
    } else if (status === 403) {
      cls = 'auth';
      extra = { tier_gated: true };
      hint = ' — subscription tier not allowlisted for OAuth inference (tier_gated)';
    }
  }
  return new LLMPolicyError(
    `[llm-transport] ${r.route} HTTP ${status}: ${text.slice(0, 300)}${hint}`,
    { class: cls, status, route: r.route, ...(extra !== undefined ? { extra } : {}) },
  );
}

/** Parse a 200 body for the route's family. */
function parseByFamily(family: Family, json: unknown, traceId: string): IRResponse {
  if (family === 'anthropic') return parseAnthropicResponse(json, traceId);
  if (family === 'xai-responses') return parseXaiResponsesResponse(json, traceId);
  return parseOpenAIResponse(json, traceId);
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
  let extraHeaders: Record<string, string>;
  try {
    ({ r, wireBody, nameMap, extraHeaders } = prepareWireCall(ir, false, traceId));
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
          ...extraHeaders,
          ...(await authHeaders(r, opts.apiKeyOverride)),
        };
        // F97: overall per-attempt deadline (replaces the legacy layer's
        // headers/body-idle guards on the buffered path). Abort → 'timeout'.
        const timeoutMs = opts.timeoutMs ?? Number(process.env['SUDO_LLM_CALL_TIMEOUT_MS'] ?? 600_000);
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(), timeoutMs);
        let response: Response;
        let raw: string;
        try {
          response = await fetchImpl(r.url, {
            method: 'POST',
            headers,
            body: wireBody,
            signal: ctx.signal !== undefined ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal,
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw httpPolicyError(r, response.status, text);
          }

          // 200: parse defensively — non-JSON bodies fall through to the
          // parsers' provider_bug path (they never throw).
          raw = await response.text().catch(() => '');
        } catch (err) {
          if (deadline.signal.aborted && !(ctx.signal !== undefined && ctx.signal.aborted)) {
            throw new LLMPolicyError(
              `[llm-transport] ${r.route}: buffered call exceeded ${timeoutMs}ms`,
              { class: 'timeout', route: r.route, retryable: true },
            );
          }
          throw err;
        } finally {
          clearTimeout(deadlineTimer);
        }
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
        let res = parseByFamily(r.family, json, traceId);
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
    // GW-1: enrich with an ESTIMATED USD cost from token counts when the
    // provider didn't hand us a real cost, so (a) gateway.db has a cost floor
    // for boot-time day-spend derivation and (b) the in-memory budget counter
    // in policy.ts actually accrues. Real provider cost, when present, wins.
    const enriched = withEstimatedCost(entry);
    recordGatewayCall(enriched);
    // Feed the asymmetric budget counter. Guard on >0 so error rows (no tokens)
    // never move the needle; recordCall is the single per-call choke point
    // (streaming writeRow is idempotent), so this counts each call exactly once.
    if (typeof enriched.costUsd === 'number' && enriched.costUsd > 0) {
      recordSpend(enriched.caller, enriched.costUsd);
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'llm_calls record failed (fail-open)');
  }
}

/**
 * GW-1: attach an estimated USD cost to a call record when one isn't already
 * set and token counts are available. Uses the resolved route (or alias) as the
 * pricing key. Never throws — a bad estimate must not block recording.
 */
function withEstimatedCost(entry: LLMCallRecord): LLMCallRecord {
  if (typeof entry.costUsd === 'number' && entry.costUsd > 0) return entry;
  const tin = entry.tokensIn ?? 0;
  const tout = entry.tokensOut ?? 0;
  if (tin <= 0 && tout <= 0) return entry;
  try {
    const model = entry.route ?? entry.alias ?? '';
    const usd = estimateCostUsd(model, tin, tout);
    if (usd > 0) return { ...entry, costUsd: usd };
  } catch {
    /* estimation is best-effort */
  }
  return entry;
}

/**
 * Test-only seam: drive the per-call accrual choke point (recordCall →
 * withEstimatedCost → recordSpend) directly, without standing up a full
 * provider round-trip. Exercises the SAME code the live transport runs, so a
 * test can assert the in-memory budget counter actually accrues.
 */
export function __recordCallForBudgetTest(entry: LLMCallRecord): void {
  recordCall(entry);
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
  toIRResponse(partialUsage?: IRUsage): IRResponse;
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
    toIRResponse(partialUsage?: IRUsage): IRResponse {
      return {
        blocks,
        // Consumer abandoned the stream before the terminal event →
        // stop_reason 'error' on the partial (mirror brain's partial-usage
        // billing philosophy: record what is known, never invent success) —
        // with the machine's last-known usage snapshot, not zeros.
        stop_reason: acc.terminal?.stop_reason ?? 'error',
        usage: acc.terminal?.usage ?? partialUsage ?? { in: 0, out: 0, cached_in: 0 },
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
    if (family !== 'anthropic' && payload.trim() === '[DONE]') {
      // xai-responses: response.completed is the in-band terminal — a
      // trailing [DONE] (if the endpoint sends one) makes end() a no-op.
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
  let extraHeaders: Record<string, string>;
  try {
    ({ r, wireBody, nameMap, extraHeaders } = prepareWireCall(ir, true, traceId));
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
          machine:
            r.family === 'xai-responses' ? createXaiResponsesSSEMachine() : createSSEMachine(r.family),
          parser: createSSEParser(),
          buffered: [],
          readerDone: false,
          cleanTerminal: false,
          truncated: false,
        };
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...extraHeaders,
          ...(await authHeaders(r, opts.apiKeyOverride)),
        };
        // runWithPolicy never populates ctx.signal (no option plumbs one in) —
        // the stream's own controller is the sole abort source for this fetch.
        // If policy ever grows a per-attempt signal, compose it here via
        // AbortSignal.any([ctx.signal, controller.signal]).
        const response = await fetchImpl(r.url, {
          method: 'POST',
          headers,
          body: wireBody,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw httpPolicyError(r, response.status, text);
        }
        if (response.body === null) {
          throw new LLMPolicyError(`[llm-transport] ${r.route}: 200 response with no body stream`, {
            class: 'provider_bug',
            route: r.route,
            retryable: false,
          });
        }
        st.reader = response.body.getReader();

        try {
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
        } catch (err) {
          // Attempt-scoped cleanup: a throw after getReader() (read error, SSE
          // parse/machine assertion) would otherwise leak THIS attempt's body
          // stream across a policy retry — the generator's outer finally only
          // cancels the reader of the attempt that was RETURNED.
          try {
            st.reader?.cancel().catch(() => {
              /* stream already errored/aborted — fine */
            });
          } catch {
            /* reader already released */
          }
          throw err;
        }
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
    // Last-known usage: terminal usage when the stream finished, otherwise the
    // machine's snapshot (anthropic message_start already carried input_tokens)
    // — cancelled streams must bill their partial usage, not zeros.
    let partial: IRUsage = { in: 0, out: 0, cached_in: 0 };
    try {
      partial = acc.terminal?.usage ?? live.machine.partialUsage;
    } catch {
      /* defensive — a broken machine getter must not mask cleanup */
    }
    try {
      opts.onPartialUsage?.({ ...partial });
    } catch {
      /* observer failures never break stream cleanup */
    }
    writeRow({
      irResponse: acc.toIRResponse(partial),
      tokensIn: partial.in,
      tokensOut: partial.out,
      tokensCached: partial.cached_in,
    });
  }
}
