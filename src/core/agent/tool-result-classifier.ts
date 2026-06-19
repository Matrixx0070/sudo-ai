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
    // Honor the canonical ToolResult.success contract first — a tool that
    // explicitly self-reports failure must not be classified as success just
    // because it lacks an `error` field.
    if (r['success'] === false) return false;
    if (r['error'] != null) return false;
    if (r['ok'] === false) return false;
    return true;
  }
  return true; // symbol, function, bigint — treat as success
}

/**
 * Resolve the success of a tool-result event, preferring the tool's own
 * authoritative `success` self-report when present and falling back to
 * classifying the (string) result only when it is absent.
 *
 * The agent loop emits `result` as the tool's OUTPUT STRING (the `ToolResult`
 * is unwrapped at emit time), so `isToolResultSuccess` alone re-guesses success
 * from text via `/^error/i` — which mislabels e.g. `{success:false,
 * output:"No matching records found"}` as success and reinforces it in the
 * policy learner. When the emitter forwards the authoritative `success`, use it.
 */
export function resolveToolSuccess(ev: { success?: boolean; result: unknown }): boolean {
  return typeof ev.success === 'boolean' ? ev.success : isToolResultSuccess(ev.result);
}
