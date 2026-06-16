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
 * Defensive extractor for Vercel AI SDK `providerMetadata` shapes. Accepts
 * the direct object (generateText) or undefined; callers awaiting a streaming
 * result should pass the resolved value (not the PromiseLike itself).
 * No-ops cleanly on non-Anthropic providers and on malformed shapes.
 */
export function recordPromptCacheUsageFromProviderMetadata(metadata: unknown): void {
  if (!metadata || typeof metadata !== 'object') return;
  const anthropic = (metadata as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return;
  const m = anthropic as { cacheCreationInputTokens?: unknown; cacheReadInputTokens?: unknown };
  const create = typeof m.cacheCreationInputTokens === 'number' ? m.cacheCreationInputTokens : 0;
  const read = typeof m.cacheReadInputTokens === 'number' ? m.cacheReadInputTokens : 0;
  recordPromptCacheUsage(create, read);
}

/** Test-only — reset counters between unit tests. */
export function _resetPromptCacheStatsForTest(): void {
  createTokens = 0;
  readTokens = 0;
  turnsWithRead = 0;
  turnsTotal = 0;
}
