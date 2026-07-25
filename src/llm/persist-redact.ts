/**
 * Redaction-before-persist helpers for the gateway call log — pure transforms
 * over IR payloads, no DB coupling; split from logging.ts under the max-lines
 * ratchet. The invariant they serve: ir_request/ir_response pass through
 * redactDeep (key-based) and every string leaf through redactSecrets
 * (pattern-based) before any byte hits disk.
 */

import { createLogger } from '../core/shared/logger.js';
import { redactDeep } from '../core/shared/redact.js';
import { redactSecrets } from '../core/federation/federation-error-sanitizer.js';

const logger = createLogger('gateway-call-log');

/**
 * Two-layer redaction for IR payloads before persist:
 *   1. redactDeep — replaces values under sensitive-looking KEYS
 *      (token/secret/key/password/auth/…) with '<redacted>'.
 *   2. redactSecrets — pattern-scrubs every remaining string LEAF
 *      (Bearer tokens, API keys, connection strings, private IPs, …).
 * Cycle-safe and depth-capped via redactDeep's own guards; the leaf pass
 * mirrors its depth cap.
 */
export function redactForPersist(input: unknown): unknown {
  return redactStringLeaves(redactDeep(input));
}

function redactStringLeaves(input: unknown, depth = 0): unknown {
  if (depth > 8) return input;
  if (typeof input === 'string') return redactSecrets(input);
  if (input === null || input === undefined || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => redactStringLeaves(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = redactStringLeaves(v, depth + 1);
  }
  return out;
}

/** JSON-serialize a redacted IR payload; undefined → NULL column. */
export function toJsonColumn(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(redactForPersist(value)) ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'IR serialization failed');
    return null;
  }
}
