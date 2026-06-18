/**
 * @file prompt-cache-discipline.ts
 * @description Stable-prefix discipline for provider prompt caches.
 *
 * Provider-side prompt caching (Anthropic explicit cache_control, OpenAI/xAI
 * implicit prefix caching) only pays off when the request prefix is
 * byte-identical across calls. Two things currently bust it on every request:
 *   1. The Current Date & Time block sits ABOVE the system prompt's
 *      __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ marker and changes every second.
 *   2. Tool definitions are serialized in arrival order, which varies with
 *      per-message tool routing.
 *
 * When SUDO_PROMPT_CACHE=1 (default OFF, fail-open):
 *   - assembleSystemPrompt moves the timestamp block below the boundary, and
 *     sorts the tools list deterministically.
 *   - Brain sorts tool definitions by name before serialization.
 *   - For Anthropic models, Brain additionally places explicit cache_control
 *     breakpoints (B2): one on the last tool definition and one on the stable
 *     part of the system prompt (everything above the dynamic boundary).
 *     Kill-switch: SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE=1 keeps the stable
 *     prefix (B1) but skips the explicit breakpoints.
 */

/** Marker separating the stable system-prompt prefix from per-call dynamic content. */
export const DYNAMIC_BOUNDARY_MARKER = '<!-- __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ -->';

/** Flag check at call time (not module load) so tests can toggle the env. */
export function isPromptCacheEnabled(): boolean {
  return process.env['SUDO_PROMPT_CACHE'] === '1';
}

/** Explicit Anthropic cache_control breakpoints (B2), on by default under the master flag. */
export function isCacheBreakpointsEnabled(): boolean {
  return isPromptCacheEnabled() && process.env['SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE'] !== '1';
}

/**
 * Model strings are "provider/model-id" (providers.ts getModel).
 *
 * Both Anthropic-direct (`anthropic/…`) and Claude OAuth subscription
 * (`claude-oauth/…`) calls reach the same upstream API and accept the same
 * `cache_control` markers. Without the `claude-oauth/` branch, subscription
 * users pay full price on every call because the cache-control breakpoints
 * silently never attach (gated on this function via brain.ts:1025 + :1157).
 * Observed empirically in the pm2 daemon's logs: zero `cacheReadInputTokens`
 * across 1600+ claude-oauth calls, full ~27 000 promptTokens billed each time.
 */
export function isAnthropicModelId(modelId: string): boolean {
  return modelId.startsWith('anthropic/') || modelId.startsWith('claude-oauth/');
}

/** Fresh object per call — providerOptions values must be plain mutable JSON. */
function anthropicEphemeralCache(): { anthropic: { cacheControl: { type: 'ephemeral' } } } {
  return { anthropic: { cacheControl: { type: 'ephemeral' } } };
}

export interface CacheAwareSystemMessage {
  role: 'system';
  content: string;
  providerOptions?: ReturnType<typeof anthropicEphemeralCache>;
}

/**
 * Split the system prompt at the dynamic boundary into SDK system messages:
 * the stable prefix carries an Anthropic cache_control breakpoint, the dynamic
 * remainder (boundary marker onward) is a second, uncached system block.
 * The @ai-sdk/anthropic provider maps consecutive system messages to separate
 * system content blocks with per-block cache_control; other providers ignore
 * the "anthropic" providerOptions namespace.
 * Callers gate on isCacheBreakpointsEnabled() + isAnthropicModelId().
 */
export function buildCachedSystemMessages(systemPrompt: string): CacheAwareSystemMessage[] {
  const idx = systemPrompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
  // No boundary, or nothing stable above it → nothing worth a breakpoint.
  if (idx <= 0) return [{ role: 'system', content: systemPrompt }];
  return [
    { role: 'system', content: systemPrompt.slice(0, idx), providerOptions: anthropicEphemeralCache() },
    { role: 'system', content: systemPrompt.slice(idx) },
  ];
}

/**
 * Attach a cache_control breakpoint to the LAST tool entry — Anthropic caches
 * the whole (deterministically sorted) tools array up to that breakpoint.
 * Pure: callers gate on isCacheBreakpointsEnabled() + isAnthropicModelId().
 */
export function markLastToolForCache<T extends object>(entries: Array<[string, T]>): Array<[string, T]> {
  if (entries.length === 0) return entries;
  const [name, tool] = entries[entries.length - 1]!;
  const marked = { ...tool, providerOptions: anthropicEphemeralCache() } as T;
  return [...entries.slice(0, -1), [name, marked]];
}

/**
 * Sort tool entries by name for a deterministic serialization order.
 * Identity (no copy, original order) when the flag is off.
 * Uses code-unit comparison, not localeCompare — locale-independent, so the
 * order is byte-stable across environments.
 */
export function sortToolEntries<T>(entries: Array<[string, T]>): Array<[string, T]> {
  if (!isPromptCacheEnabled()) return entries;
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sort arbitrary items by an extracted name with the same semantics. */
export function sortByName<T>(items: T[], getName: (item: T) => string): T[] {
  if (!isPromptCacheEnabled()) return items;
  return [...items].sort((x, y) => {
    const a = getName(x);
    const b = getName(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
