/**
 * @file src/llm/cache/canonical.ts
 * @description Canonical, deterministic content fingerprint for an IRRequest —
 * the cache-key substrate for the gateway caching subsystem AND the dedup key
 * for the Phase-0 savings-ceiling probe.
 *
 * WHY a separate fingerprint instead of reusing `wire_payload_sha256`:
 *  - `wire_payload_sha256` hashes the exact provider wire bytes as computed
 *    on the IR-transport path (F97: the only wire path; historical legacy
 *    rows carry NULL). This fingerprint is computed
 *    centrally in GatewayCallLog.record() from `ir_request`, which is populated
 *    for 100% of rows, so Phase-0 dedup measurement covers every caller.
 *  - The wire bytes carry VOLATILE fields (stream flag, x-grok-conv-id source,
 *    derived thinking/max_tokens) that would bust dedup. The fingerprint is
 *    computed over a SEMANTIC PROJECTION only.
 *
 * Determinism rules (cross-cutting gotcha §vii — byte-exact keys):
 *  - Object keys are sorted recursively; array order is PRESERVED (message and
 *    tool order are semantic, and preserving order is fail-CLOSED: at worst two
 *    orderings map to distinct keys — never a false cache hit).
 *  - Only semantically-answer-determining fields enter the key. Volatile /
 *    routing / telemetry fields are excluded so the same content from different
 *    callers or conversations collides.
 *
 * This module changes ZERO wire bytes — it never touches what is sent to a
 * provider. It only derives a hash.
 */

import { createHash } from 'node:crypto';
import type { IRRequest } from '../../../shared-types/ir/v1.js';

/**
 * Bump to invalidate every derived key globally (schemaVer discipline). Any
 * change to the projection below or the serialization MUST bump this.
 */
export const CACHE_KEY_SCHEMA_VERSION = 1 as const;

/**
 * Fields that DETERMINE the model's answer and therefore belong in the key.
 * Everything else on IRRequest is excluded (see EXCLUDED below).
 */
interface KeyProjection {
  alias: unknown;
  system?: unknown;
  messages: unknown;
  tools?: unknown;
  response_schema?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

/**
 * Excluded from the key ON PURPOSE:
 *  - trace_id   : unique per call — would make every key unique (zero dedup).
 *  - caller     : same content from different subsystems SHOULD collide.
 *  - purpose    : telemetry only.
 *  - priority   : user/background lane never changes the answer.
 *  - extra      : vendor extras incl. the volatile conv_id caching header.
 */
function projectForKey(ir: IRRequest): KeyProjection {
  const proj: KeyProjection = {
    alias: ir.alias,
    messages: ir.messages,
  };
  if (ir.system !== undefined) proj.system = ir.system;
  if (ir.tools !== undefined) proj.tools = ir.tools;
  if (ir.response_schema !== undefined) proj.response_schema = ir.response_schema;
  if (ir.max_tokens !== undefined) proj.max_tokens = ir.max_tokens;
  if (ir.temperature !== undefined) proj.temperature = ir.temperature;
  return proj;
}

/**
 * Deterministic JSON: object keys sorted recursively, array order preserved,
 * `undefined` members omitted. No dependency on JS object insertion order, so
 * two structurally-equal projections serialize byte-identically.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify(undefined) === undefined → normalize to the JSON null token
    // (undefined never reaches here for object members; they are skipped below).
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v === undefined ? null : v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // omit undefined members (matches JSON.stringify)
    parts.push(JSON.stringify(key) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Canonical string form of the IR's semantic projection, version-tagged so a
 * CACHE_KEY_SCHEMA_VERSION bump changes every fingerprint.
 */
export function canonicalize(ir: IRRequest): string {
  return `ck${CACHE_KEY_SCHEMA_VERSION}:` + stableStringify(projectForKey(ir));
}

/**
 * SHA-256 hex fingerprint of the canonical projection. One-way: the stored
 * hash never leaks request content. Deterministic across callers, conversations
 * and JSON key ordering; sensitive to model/alias, system, messages, tools,
 * response_schema, max_tokens and temperature.
 */
export function contentFingerprint(ir: IRRequest): string {
  return createHash('sha256').update(canonicalize(ir)).digest('hex');
}
