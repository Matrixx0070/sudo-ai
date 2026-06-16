/**
 * @file arsenal-v2/cascade.ts
 * @description Per-attempt model cascade for the slice-5 retry loop.
 *
 * In slice 5 every retry attempt reused the same model — if the model
 * couldn't satisfy the critic on attempt 1, repeating the same model on
 * attempt 2 with only the critique appended often produces the same
 * mistake. The cascade is a prioritized list of models: attempt N uses
 * `cascade[N-1]`, escalating to a stronger or differently-aligned model
 * each round. Once we run past the end of the list, we stick with the
 * last entry (the strongest fallback).
 *
 * Sources of the cascade (highest priority first):
 *   1. Tool param `models: string[]`  — explicit per-call cascade.
 *   2. Env  `SUDO_ARSENAL_V2_CASCADE`  — comma-separated list.
 *   3. Tool param `model` or env `SUDO_ARSENAL_V2_MODEL` — single-element
 *      cascade (no escalation, same model every attempt).
 *   4. The static DEFAULT_MODEL — single-element cascade.
 *
 * Returns at least one model id. Empty / non-string entries are filtered.
 * Order is preserved; duplicates are dropped so a misconfigured
 * "claude,claude,claude" doesn't disable escalation.
 */

export interface ParseCascadeArgs {
  /** Tool param `models` — array of model ids (highest priority). */
  models?: unknown;
  /** Tool param `model` — single model id (lower than `models`). */
  model?: string;
  /** Env `SUDO_ARSENAL_V2_CASCADE` — comma-separated. */
  envCascade?: string;
  /** Env `SUDO_ARSENAL_V2_MODEL` — single id. */
  envModel?: string;
  /** Static fallback when nothing else is provided. */
  defaultModel: string;
}

export function parseCascade(args: ParseCascadeArgs): string[] {
  // 1. Tool param `models` wins when it's a non-empty string array.
  if (Array.isArray(args.models)) {
    const list = normalize(args.models);
    if (list.length > 0) return list;
  }
  // 2. Env cascade.
  if (args.envCascade && args.envCascade.trim()) {
    const list = normalize(args.envCascade.split(','));
    if (list.length > 0) return list;
  }
  // 3. Single model from tool param or env.
  const single = (args.model && args.model.trim()) || (args.envModel && args.envModel.trim()) || '';
  if (single) return [single];
  // 4. Default.
  return [args.defaultModel];
}

/**
 * Pick the model for attempt N (1-indexed). When `attemptIndex` exceeds the
 * cascade length, the LAST model is reused — we don't error or wrap around.
 */
export function modelForAttempt(cascade: string[], attemptIndex: number): string {
  if (cascade.length === 0) throw new Error('cascade must have at least one model');
  if (attemptIndex < 1) return cascade[0]!;
  if (attemptIndex > cascade.length) return cascade[cascade.length - 1]!;
  return cascade[attemptIndex - 1]!;
}

function normalize(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
