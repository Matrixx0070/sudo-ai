/**
 * @file tool-args.ts
 * @description The ONE place stringified tool-call arguments become real
 * objects (gw-refactor Phase 3). Every ingress/response/stream path funnels
 * through parseToolArguments so the "parse exactly once" rule has a single
 * enforcement point: JSON.parse first, jsonrepair fallback, and if still
 * unrecoverable → `{}` plus an error string the caller records under
 * `extra.parse_error` (never a throw).
 */

import { jsonrepair } from 'jsonrepair';

export interface ParsedToolArgs {
  /** Always a real object — `{}` when the raw string was unrecoverable. */
  input: Record<string, unknown>;
  /** Present only when the raw string could not be parsed into an object. */
  error?: string;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/** Parse a provider's stringified `function.arguments` into a real object. */
export function parseToolArguments(raw: string): ParsedToolArgs {
  const trimmed = raw.trim();
  if (trimmed === '') return { input: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const obj = asObject(parsed);
    if (obj !== undefined) return { input: obj };
    return { input: {}, error: `arguments parsed to non-object (${typeof parsed})` };
  } catch {
    // First parse failed — attempt jsonrepair, then parse the repaired text.
    try {
      const repaired: unknown = JSON.parse(jsonrepair(trimmed));
      const obj = asObject(repaired);
      if (obj !== undefined) return { input: obj };
      return { input: {}, error: 'repaired arguments parsed to non-object' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { input: {}, error: `unrecoverable tool arguments: ${msg}` };
    }
  }
}
