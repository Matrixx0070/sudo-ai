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
import type { IRRequest, IRMessage, IRContentBlock } from '../../shared-types/ir/v1.js';

export interface AliasLimits {
  /** Total context window (input + output), tokens. */
  context_window: number;
  /** Max output tokens per completion. */
  max_output: number;
}

/** Conservative fallback for anything we do not recognize. */
export const DEFAULT_LIMITS: AliasLimits = { context_window: 128_000, max_output: 8192 };

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

  // Anthropic — 200K context; 32000 output (DEFAULT_MODEL_MAX, thinking-inject.ts).
  'anthropic/claude-opus-4-8': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-7': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-6': { context_window: 200_000, max_output: 32_000 },
  'anthropic/claude-opus-4-5': { context_window: 200_000, max_output: 32_000 },

  // OpenAI
  'openai/gpt-4o': { context_window: 128_000, max_output: 16_384 },
  'openai/gpt-4o-mini': { context_window: 128_000, max_output: 16_384 },
  'openai/text-embedding-3-small': { context_window: 8_191, max_output: 0 },

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
  'sudo/frontier': MODEL_LIMITS['anthropic/claude-opus-4-8']!,
  'sudo/embed': MODEL_LIMITS['openai/text-embedding-3-small']!,
  'sudo/vision': MODEL_LIMITS['xai/grok-4-fast']!,
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
