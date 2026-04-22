/** @file tool-result-classifier.ts — classify tool execution result as success or failure. */

/**
 * Determine whether a tool execution result represents a successful outcome.
 *
 * Rules (evaluated in order):
 *  1. null / undefined        → true  (no error returned = success)
 *  2. boolean                 → result itself (false = failure)
 *  3. number                  → true  (numeric results = success)
 *  4. string                  → !(/^error/i.test(result)) (catches 'Error...' and 'error...')
 *  5. Array                   → true  (array results = success)
 *  6. object                  → false if r.error != null OR r.ok === false; else true
 *  7. symbol / function / etc → true  (treat as success)
 *
 * @param result - The raw result value returned by a tool's execute() function.
 */
export function isToolResultSuccess(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (typeof result === 'boolean') return result;
  if (typeof result === 'number') return true;
  if (typeof result === 'string') return !/^error/i.test(result);
  if (Array.isArray(result)) return true;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r['error'] != null) return false;
    if (r['ok'] === false) return false;
    return true;
  }
  return true; // symbol, function, bigint — treat as success
}
