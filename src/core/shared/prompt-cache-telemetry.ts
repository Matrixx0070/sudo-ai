/**
 * @file prompt-cache-telemetry.ts
 * @description In-process counters for Anthropic prompt-cache token usage.
 *
 * Brain records into this module after each LLM call that returns Anthropic
 * `cacheCreationInputTokens` / `cacheReadInputTokens` via Vercel AI SDK's
 * `providerMetadata.anthropic.*`. The gateway's /health endpoint reads the
 * snapshot so the cache-discipline flip (SUDO_PROMPT_CACHE=1) is measurable.
 *
 * Counters are best-effort and process-local: reset on PM2 restart, no
 * persistence, no aggregation across instances. For real cost tracking, use
 * the per-call cost-tracker.
 *
 * Why a shared module: brain → gateway would be a wrong-direction import.
 * Both subsystems depend on shared, no cycle.
 */

let createTokens = 0; // cumulative tokens written to Anthropic cache
let readTokens = 0; // cumulative tokens served from Anthropic cache
let turnsWithRead = 0; // turns where cacheReadInputTokens > 0
let turnsTotal = 0; // turns where at least one cache field was non-zero (Anthropic-routed turns)

export interface PromptCacheStats {
  promptCacheCreateTokens: number;
  promptCacheReadTokens: number;
  promptCacheTurnsWithRead: number;
  promptCacheTurnsTotal: number;
  promptCacheHitRate: number; // turnsWithRead / turnsTotal, rounded to 3 decimals; 0 when no turns recorded
}

/**
 * Record one LLM-call's prompt-cache token usage. Pass the raw values from
 * Vercel AI SDK's `providerMetadata.anthropic.cacheCreationInputTokens` and
 * `cacheReadInputTokens`. A turn is only counted toward `turnsTotal` when at
 * least one value is positive — non-Anthropic providers therefore don't
 * pollute the denominator.
 */
export function recordPromptCacheUsage(create: number, read: number): void {
  const c = Number.isFinite(create) && create > 0 ? create : 0;
  const r = Number.isFinite(read) && read > 0 ? read : 0;
  if (c === 0 && r === 0) return;
  createTokens += c;
  readTokens += r;
  turnsTotal += 1;
  if (r > 0) turnsWithRead += 1;
}

export function getPromptCacheStats(): PromptCacheStats {
  const hitRate = turnsTotal === 0 ? 0 : Math.round((turnsWithRead / turnsTotal) * 1000) / 1000;
  return {
    promptCacheCreateTokens: createTokens,
    promptCacheReadTokens: readTokens,
    promptCacheTurnsWithRead: turnsWithRead,
    promptCacheTurnsTotal: turnsTotal,
    promptCacheHitRate: hitRate,
  };
}

/**
 * Defensive extractor for Vercel AI SDK `providerMetadata` shapes. Returns the
 * Anthropic prompt-cache token counts, or zeros for non-Anthropic / malformed
 * shapes.
 *
 * Field-shape note (ai@6 / @ai-sdk/anthropic@3): the authoritative counts live
 * NESTED under `anthropic.usage.{cache_creation_input_tokens,cache_read_input_tokens}`
 * (snake_case, the raw Anthropic usage object the SDK passes through). The SDK
 * ALSO surfaces a top-level camelCase `anthropic.cacheCreationInputTokens`, but
 * there is NO top-level `cacheReadInputTokens` — so reading only the camelCase
 * fields silently loses every cache READ (creation records, reads vanish). We
 * read the nested usage first and fall back to the camelCase top-level for
 * forward/backward compatibility.
 */
export function extractPromptCacheTokens(metadata: unknown): { create: number; read: number } {
  const zero = { create: 0, read: 0 };
  if (!metadata || typeof metadata !== 'object') return zero;
  const anthropic = (metadata as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return zero;
  const a = anthropic as {
    usage?: { cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };
    cacheCreationInputTokens?: unknown;
    cacheReadInputTokens?: unknown;
  };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const create = num(a.usage?.cache_creation_input_tokens) || num(a.cacheCreationInputTokens);
  const read = num(a.usage?.cache_read_input_tokens) || num(a.cacheReadInputTokens);
  return { create, read };
}

/**
 * Record one LLM call's prompt-cache usage straight from `providerMetadata`.
 * Accepts the direct object (generateText) or undefined; callers awaiting a
 * streaming result should pass the resolved value (not the PromiseLike itself).
 * No-ops cleanly on non-Anthropic providers and on malformed shapes.
 */
export function recordPromptCacheUsageFromProviderMetadata(metadata: unknown): void {
  const { create, read } = extractPromptCacheTokens(metadata);
  recordPromptCacheUsage(create, read);
}

/** Test-only — reset counters between unit tests. */
export function _resetPromptCacheStatsForTest(): void {
  createTokens = 0;
  readTokens = 0;
  turnsWithRead = 0;
  turnsTotal = 0;
}
