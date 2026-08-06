/**
 * @file limits.ts
 * @description Context-window / max-output budgets per alias or concrete
 * model, plus a rough token estimator for IR payloads (gw-refactor Phase 2).
 *
 * `getAliasLimits()` is synchronous and always answers: gateway-refreshed
 * overrides win, then the hardcoded fallback table, then DEFAULT_LIMITS.
 * `refreshAliasLimitsFromGateway()` optionally pulls live metadata from
 * `${LLM_BASE_URL}/v1/models` into an in-memory override map — fail-open:
 * any network/shape error leaves the fallbacks untouched.
 *
 * Sources for the fallback numbers:
 * - anthropic/claude-opus-*: 200K context (src/core/agent/context.ts:
 *   "Claude models are ~200K"), 32000 output ceiling (DEFAULT_MODEL_MAX in
 *   src/core/brain/thinking-inject.ts — the only hard limit in the repo).
 * - xai/grok-4-fast* and grok-4-1-fast*: 2M context per xAI's published
 *   specs (no table existed in-repo; costs.ts only tracks prices).
 * - Everything else: vendor-published values, conservative where unsure.
 */

import { resolveAlias, SUDO_ALIASES, type SudoAlias } from './aliases.js';
import { rateFor as catalogRateFor, meteredCostUsd } from './model-catalog.js';
import type { IRRequest, IRMessage, IRContentBlock } from '../../shared-types/ir/v1.js';

export interface AliasLimits {
  /** Total context window (input + output), tokens. */
  context_window: number;
  /** Max output tokens per completion. */
  max_output: number;
}

/** Conservative fallback for anything we do not recognize. */
export const DEFAULT_LIMITS: AliasLimits = { context_window: 128_000, max_output: 8192 };

/**
 * Output-token floor for reasoning models on the OpenAI-compatible wire.
 *
 * These models emit `reasoning` tokens BEFORE `content`. Below this floor the
 * whole budget is consumed by thinking and the response returns
 * `content:'' finish_reason:'length'` — a truncation that is indistinguishable
 * downstream from a dead provider. Measured 2026-07-29: glm-5.2:cloud at
 * max_tokens 64 produced 213-252 reasoning tokens and EMPTY content on 5/5 raw
 * calls; at 2048 it answered every time. 1024 clears the observed reasoning
 * length with room for a real answer.
 */
export const REASONING_MIN_OUTPUT_TOKENS = 1024;

/**
 * Models that spend output budget on reasoning before content. Matched on the
 * bare model id so `ollama/glm-5.2:cloud` and a future `glm-5.3:cloud` both
 * hit it. Deliberately a prefix/substring list rather than exact ids — new
 * point releases must not silently fall back to the non-reasoning path.
 */
const REASONING_MODEL_MARKERS = ['glm-', 'deepseek-r', 'qwq', 'kimi-k2', 'o1-', 'o3-', 'o4-'] as const;

/** True when the model emits reasoning tokens ahead of content. */
export function isReasoningModel(model: string): boolean {
  const bare = bareModel(resolveAlias(model)).toLowerCase();
  return REASONING_MODEL_MARKERS.some((m) => bare.startsWith(m) || bare.includes(`/${m}`));
}

// ---------------------------------------------------------------------------
// Fallback table
// ---------------------------------------------------------------------------

/**
 * Keyed by concrete `provider/model` id. Sudo aliases are resolved through
 * resolveAlias() first, so the table stays alias-agnostic; explicit alias
 * entries below act as a safety net if resolution ever changes.
 */
const MODEL_LIMITS: Record<string, AliasLimits> = {
  // xAI — grok-4-fast family has a 2M-token context window.
  'xai/grok-4-fast': { context_window: 2_000_000, max_output: 32_768 },
  'xai/grok-4-fast-reasoning': { context_window: 2_000_000, max_output: 32_768 },
  'xai/grok-4-fast-non-reasoning': { context_window: 2_000_000, max_output: 32_768 },
  'xai/grok-4-1-fast-reasoning': { context_window: 2_000_000, max_output: 32_768 },
  'xai/grok-4-1-fast-non-reasoning': { context_window: 2_000_000, max_output: 32_768 },
  'xai/grok-4-0709': { context_window: 256_000, max_output: 32_768 },
  'xai/grok-code-fast-1': { context_window: 256_000, max_output: 32_768 },
  'xai/grok-3': { context_window: 131_072, max_output: 16_384 },
  'xai/grok-3-mini': { context_window: 131_072, max_output: 16_384 },
  'xai/grok-3-fast': { context_window: 131_072, max_output: 16_384 },

  // xai-oauth subscription proxy (GX1) — served by cli-chat-proxy.grok.com.
  'xai-oauth/grok-build': { context_window: 512_000, max_output: 32_768 },
  'xai-oauth/grok-composer-2.5-fast': { context_window: 200_000, max_output: 32_768 },

  // Anthropic — 200K context; 32000 output (DEFAULT_MODEL_MAX, thinking-inject.ts).
  // claude-opus-5: 1M context / 128K output — confirmed live via GET
  // /v1/models/claude-opus-5 (2026-07-30) and platform.claude.com models table.
  'anthropic/claude-opus-5': { context_window: 1_000_000, max_output: 128_000 },
  'anthropic/claude-opus-4-8': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-7': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-6': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-5': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-haiku-4-5-20251001': { context_window: 200_000, max_output: 32_000 },

  // OpenAI
  'openai/gpt-4o': { context_window: 128_000, max_output: 16_384 },
  'openai/gpt-4o-mini': { context_window: 128_000, max_output: 16_384 },
  'openai/text-embedding-3-small': { context_window: 8_191, max_output: 0 },
  'ollama/nomic-embed-text': { context_window: 8_192, max_output: 0 },

  // Local
  'ollama/llama3.2': { context_window: 128_000, max_output: 8_192 },
};

/**
 * Explicit per-alias safety net (matches the DEFAULTS in aliases.ts). Used
 * only when resolveAlias() returns something the model table doesn't know.
 */
const ALIAS_LIMITS: Record<SudoAlias, AliasLimits> = {
  'sudo/local': MODEL_LIMITS['ollama/llama3.2']!,
  'sudo/cheap': MODEL_LIMITS['xai/grok-4-fast-non-reasoning']!,
  'sudo/mid': MODEL_LIMITS['xai/grok-4-fast-reasoning']!,
  'sudo/frontier': MODEL_LIMITS['anthropic/claude-opus-5']!,
  'sudo/embed': MODEL_LIMITS['openai/text-embedding-3-small']!,
  'sudo/vision': MODEL_LIMITS['xai/grok-4-fast']!,
  'sudo/judge': MODEL_LIMITS['anthropic/claude-haiku-4-5-20251001']!,
};

/** In-memory overrides populated by refreshAliasLimitsFromGateway(). */
const gatewayOverrides = new Map<string, AliasLimits>();

/** Strip the provider prefix: "xai/grok-3" → "grok-3". */
function bareModel(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

function lookupTable(key: string): AliasLimits | undefined {
  const direct = MODEL_LIMITS[key];
  if (direct) return direct;
  // Match bare model names against table entries ("grok-4-fast-reasoning"
  // hits "xai/grok-4-fast-reasoning").
  const bare = bareModel(key);
  for (const [k, v] of Object.entries(MODEL_LIMITS)) {
    if (bareModel(k) === bare) return v;
  }
  return undefined;
}

/**
 * Synchronous limits lookup. Precedence: gateway override (alias, then
 * resolved model, then bare model) → fallback table → alias safety net →
 * DEFAULT_LIMITS. Never throws, never returns undefined.
 */
export function getAliasLimits(alias: string): AliasLimits {
  const resolved = resolveAlias(alias);
  const override =
    gatewayOverrides.get(alias) ??
    gatewayOverrides.get(resolved) ??
    gatewayOverrides.get(bareModel(resolved));
  if (override) return { ...override };

  const fromTable = lookupTable(resolved) ?? lookupTable(alias);
  if (fromTable) return { ...fromTable };

  if ((SUDO_ALIASES as readonly string[]).includes(alias)) {
    return { ...ALIAS_LIMITS[alias as SudoAlias] };
  }
  return { ...DEFAULT_LIMITS };
}

// ---------------------------------------------------------------------------
// Gateway refresh
// ---------------------------------------------------------------------------

interface GatewayModelEntry {
  id?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_output_tokens?: unknown;
  max_output?: unknown;
}

function asPositiveNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Pull model metadata from `${LLM_BASE_URL}/v1/models` into the in-memory
 * override map. Sync `getAliasLimits()` reads overrides first, so refreshed
 * numbers win on the next call. Fail-open: no LLM_BASE_URL, network errors,
 * non-2xx or unexpected shapes all leave existing fallbacks in place.
 *
 * @returns number of models whose limits were updated.
 */
export async function refreshAliasLimitsFromGateway(): Promise<number> {
  const base = process.env['LLM_BASE_URL']?.trim().replace(/\/+$/, '');
  if (!base) return 0;
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: process.env['LLM_API_KEY']
        ? { Authorization: `Bearer ${process.env['LLM_API_KEY']}` }
        : undefined,
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { data?: unknown };
    const entries = Array.isArray(body?.data) ? (body.data as GatewayModelEntry[]) : [];
    let updated = 0;
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || entry.id === '') continue;
      const ctx = asPositiveNumber(entry.context_window) ?? asPositiveNumber(entry.context_length);
      const out = asPositiveNumber(entry.max_output_tokens) ?? asPositiveNumber(entry.max_output);
      if (ctx === undefined && out === undefined) continue;
      const current = getAliasLimits(entry.id);
      gatewayOverrides.set(entry.id, {
        context_window: ctx ?? current.context_window,
        max_output: out ?? current.max_output,
      });
      updated++;
    }
    return updated;
  } catch {
    // Fail-open: keep fallbacks.
    return 0;
  }
}

/** Test seam: drop all gateway-refreshed overrides. */
export function clearGatewayLimitOverrides(): void {
  gatewayOverrides.clear();
}

// ---------------------------------------------------------------------------
// Cost estimation (GW-1) — minimal static price map, ESTIMATE only
// ---------------------------------------------------------------------------

/**
 * USD per 1,000,000 tokens (input / output). Deliberately a SMALL static map
 * living in src/llm (not imported from core/brain/costs.ts) so the policy layer
 * stays dependency-light. These are list-price ESTIMATES for budgeting, NOT
 * billing truth — the durable per-call cost in gateway.db is authoritative.
 * Keep the frontier/failover rows honest: grok-4.5 caches nothing and is the
 * expensive failover landing (GW-2), so its per-token price is set high on
 * purpose to make the budget bite.
 */
interface PriceRate {
  inUsdPerM: number;
  outUsdPerM: number;
}

const PRICE_TABLE: Record<string, PriceRate> = {
  // xAI — fast tier (cheap, caches well)
  'xai/grok-4-fast': { inUsdPerM: 0.2, outUsdPerM: 0.5 },
  'xai/grok-4-fast-reasoning': { inUsdPerM: 0.2, outUsdPerM: 0.5 },
  'xai/grok-4-fast-non-reasoning': { inUsdPerM: 0.2, outUsdPerM: 0.5 },
  'xai/grok-4-1-fast-reasoning': { inUsdPerM: 0.2, outUsdPerM: 0.5 },
  'xai/grok-4-1-fast-non-reasoning': { inUsdPerM: 0.2, outUsdPerM: 0.5 },
  'xai/grok-4-0709': { inUsdPerM: 2.0, outUsdPerM: 6.0 },
  // xAI — premium / failover landing (no caching → effectively ~10x, GW-2)
  'xai/grok-4.5': { inUsdPerM: 3.0, outUsdPerM: 15.0 },
  'xai-oauth/grok-4.5': { inUsdPerM: 3.0, outUsdPerM: 15.0 },
  'xai/grok-3-fast': { inUsdPerM: 5.0, outUsdPerM: 25.0 },
  // xai-oauth subscription proxy (GX1). These were priced 0 on the premise that
  // the lane was SEAT-COVERED. **That premise was DISPROVEN live 2026-07-31:**
  // cli-chat-proxy meters on BOTH principals of this account — `grok-4.5`
  // resolves server-side to `grok-4.5-build` and returned service_tier 'default'
  // with cost_in_usd_ticks 7_444_000 (~$0.0074) on the SuperGrok-bearing team
  // (56504cd4), 6_724_000 on the personal one. `grok-4.5-build-free` now 404s
  // ("your team ... does not have access to it"). A $0 price told the budget
  // counter this metered model was free, so nothing bounded it — console shows
  // $161.27 invoiced over 30d.
  //
  // Priced at xAI's published grok-4.5 rate. Pre-flight ESTIMATE only, and a
  // known FLOOR: observed effective cost runs ~3-4x this (reasoning tokens are
  // billed but excluded from output_tokens). The authoritative figure is the
  // provider's own cost_in_usd_ticks, recorded per call since PR #1052.
  'xai-oauth/grok-build': { inUsdPerM: 3.0, outUsdPerM: 15.0 },
  'xai-oauth/grok-composer-2.5-fast': { inUsdPerM: 3.0, outUsdPerM: 15.0 },
  // Anthropic (claude-oauth/* routes are seat-classified above and never
  // reach this table; these rows cover the API-key lane).
  'anthropic/claude-opus-5': { inUsdPerM: 5.0, outUsdPerM: 25.0 },
  'anthropic/claude-opus-4-8': { inUsdPerM: 5.0, outUsdPerM: 25.0 },
  'anthropic/claude-opus-4-7': { inUsdPerM: 5.0, outUsdPerM: 25.0 },
  'anthropic/claude-haiku-4-5-20251001': { inUsdPerM: 1.0, outUsdPerM: 5.0 },
  // OpenAI
  'openai/gpt-4o': { inUsdPerM: 2.5, outUsdPerM: 10.0 },
  'openai/gpt-4o-mini': { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  'openai/text-embedding-3-small': { inUsdPerM: 0.02, outUsdPerM: 0.0 },
  // Local (free)
  'ollama/llama3.2': { inUsdPerM: 0.0, outUsdPerM: 0.0 },
};

/** Conservative fallback when the model is unknown (ESTIMATE, mid-tier). */
const DEFAULT_PRICE: PriceRate = { inUsdPerM: 3.0, outUsdPerM: 15.0 };

/**
 * Providers whose calls are covered by a flat subscription seat, never
 * per-token metered — same rationale as the GX1 grok seat rows above: priced
 * 0 so the budget counter never accrues phantom metered spend (2026-07-22:
 * 418 claude-oauth calls ≈ "$51" of phantom spend blew the $50 daily cap and
 * degraded/skipped free calls all afternoon). The durable gateway.db row
 * still records token counts for telemetry; the budget bounds METERED spend.
 */
// The pricing key may be a `provider/model` id OR a transport route
// (`claude-oauth:messages`) — match the provider under both separators.
//
// `ollama/` added 2026-07-29. Ollama Cloud is a flat Pro subscription with
// session + weekly quotas — verified on the live account page: Extra-usage
// balance $0 with auto-reload OFF, so it CANNOT bill; when quota runs out
// calls fail (5xx/429) and failover handles them. Previously only the bare
// `ollama/llama3.2` sat in PRICE_TABLE, so every `:cloud` model
// (kimi-k2.7-code:cloud, glm-5.2:cloud) missed both the table and this list
// and fell through to DEFAULT_PRICE — accounted at Claude-Sonnet rates
// ($3/$15 per M). That booked ~$0.73 per 80k-in/32k-out call and ~$473 of
// PHANTOM spend in five days, which tripped SUDO_DAILY_LLM_BUDGET_USD daily
// and then blocked the genuinely-free claude-oauth seat as well — turning a
// spend cap into a total product outage. Seat classification also subjects
// ollama to the policy layer's call-count ceiling, which is the brake that
// actually matches a quota-based plan (dollars never bounded it).
const SEAT_PROVIDERS = ['claude-oauth/', 'claude-oauth:', 'ollama/', 'ollama:'] as const;
const SEAT_PRICE: PriceRate = { inUsdPerM: 0.0, outUsdPerM: 0.0 };

/**
 * True when a pricing key / transport route rides a flat-subscription seat.
 * Shared with the policy layer's seat call-count ceiling so "priced at 0" and
 * "counted against the seat ceiling" can never drift apart.
 */
export function isSeatKey(key: string): boolean {
  return SEAT_PROVIDERS.some((p) => key.startsWith(p));
}

function priceFor(model: string): PriceRate {
  const resolved = resolveAlias(model);
  // ADR 0010 D2: the catalog is the single source. Seat lanes still resolve to
  // $0 here — that is the rule two outages were caused by breaking
  // (see the SEAT_PROVIDERS comment above and model-catalog.ts).
  if (isSeatKey(resolved) || isSeatKey(model)) return SEAT_PRICE;
  const rate = catalogRateFor(resolved);
  return { inUsdPerM: rate.inUsdPerM, outUsdPerM: rate.outUsdPerM };
}

/**
 * GW-1: rough USD cost for a call, from token counts × the static price map.
 * ESTIMATE only — used for pre-flight budget accounting and (when the real
 * provider cost is absent) the recorded cost floor. Accepts an alias or a
 * concrete `provider/model` id. Ollama / unknown-free models cost 0.
 */
export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const resolved = resolveAlias(model);
  const tin = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const tout = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  // This feeds the DAILY BUDGET, so it must be REAL money: seat lanes are $0
  // by classification (never by a $0 price), and tiered models are honoured.
  if (isSeatKey(resolved) || isSeatKey(model)) return 0;
  return meteredCostUsd(resolved, { inputTokens: tin, outputTokens: tout });
}

// ---------------------------------------------------------------------------
// Token estimator
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4; // rough English/code average
const PER_MESSAGE_OVERHEAD = 4; // role + framing tokens
const PER_BLOCK_OVERHEAD = 6; // block type/id framing
const IMAGE_TOKENS = 1500; // Anthropic-ish flat cost per image

function textTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function jsonTokens(v: unknown): number {
  try {
    return textTokens(JSON.stringify(v) ?? '');
  } catch {
    return 0;
  }
}

function blockTokens(block: IRContentBlock): number {
  let t = PER_BLOCK_OVERHEAD;
  switch (block.type) {
    case 'text':
      t += textTokens(block.text);
      break;
    case 'tool_use':
      t += textTokens(block.name) + jsonTokens(block.input);
      break;
    case 'tool_result':
      if (typeof block.content === 'string') {
        t += textTokens(block.content);
      } else {
        for (const inner of block.content) {
          t += inner.type === 'image' ? IMAGE_TOKENS : PER_BLOCK_OVERHEAD + textTokens(inner.text);
        }
      }
      break;
    case 'image':
      t += IMAGE_TOKENS;
      break;
    case 'thinking':
      t += textTokens(block.thinking);
      break;
  }
  return t;
}

function messagesTokens(messages: IRMessage[]): number {
  let t = 0;
  for (const m of messages) {
    t += PER_MESSAGE_OVERHEAD;
    for (const block of m.content) t += blockTokens(block);
  }
  return t;
}

/**
 * Rough token estimate for budgeting/compaction decisions — NOT a real
 * tokenizer. Heuristic (±10% is fine for its purpose):
 * - text: chars / 4
 * - + ~4 tokens overhead per message, ~6 per content block
 * - images: flat 1500 tokens each (Anthropic-ish)
 * - tool_use input / tool definitions / response_schema: JSON.stringify / 4
 * - IRRequest counts system text and tool definitions too.
 */
export function estimateTokens(ir: IRRequest | IRMessage[] | string): number {
  if (typeof ir === 'string') return textTokens(ir);
  if (Array.isArray(ir)) return messagesTokens(ir);

  let t = messagesTokens(ir.messages);
  if (ir.system) t += textTokens(ir.system) + PER_MESSAGE_OVERHEAD;
  if (ir.tools) {
    for (const tool of ir.tools) {
      t +=
        PER_BLOCK_OVERHEAD +
        textTokens(tool.name) +
        textTokens(tool.description ?? '') +
        jsonTokens(tool.input_schema);
    }
  }
  if (ir.response_schema) t += jsonTokens(ir.response_schema);
  return t;
}
