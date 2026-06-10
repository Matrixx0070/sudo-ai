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
 */

/** Flag check at call time (not module load) so tests can toggle the env. */
export function isPromptCacheEnabled(): boolean {
  return process.env['SUDO_PROMPT_CACHE'] === '1';
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
