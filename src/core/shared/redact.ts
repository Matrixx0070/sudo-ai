/**
 * @file shared/redact.ts
 * @description Key-based deep secret redaction for object graphs.
 *
 * Replaces string values whose KEY looks sensitive (token/secret/key/password/
 * auth/credential/JWT/bearer) with `<redacted>`, recursively. Used at any point
 * we persist or share arbitrary captured data — e.g. tool-call args in the trace
 * store, which the repair flywheel later replays: the flywheel needs the shape of
 * the input, never the secret in it.
 *
 * Cycle-safe (WeakSet) and depth-capped. Arrays and primitives pass through.
 */

export const SENSITIVE_KEY_REGEX = /TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|CRED|PRIVATE|JWT|BEARER/i;

export function redactDeep(input: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > 6) return '<max-depth>';
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (seen.has(input as object)) return '<cycle>';
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((v) => redactDeep(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) out[k] = '<redacted>';
    else out[k] = redactDeep(v, depth + 1, seen);
  }
  return out;
}
