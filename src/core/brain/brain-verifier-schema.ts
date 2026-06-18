/**
 * @file brain-verifier-schema.ts
 * @description JSON-shape verifier for the tree-search orchestrator
 * (#240). Second algorithmic judge after the test-execution verifier
 * (#241): scores candidates by whether their output parses as JSON and
 * matches a caller-supplied shape.
 *
 * Use when the brain.call is supposed to produce structured output —
 * routing decisions, plan trees, classification verdicts, anything with
 * a JSON contract. The exec verifier needs a test command + workspace;
 * the schema verifier is a pure function over the response text.
 *
 *   const verifier = makeSchemaVerifier({
 *     requiredFields: ['intent', 'targets'],
 *     predicate: (j) => Array.isArray((j as { targets: unknown }).targets),
 *   });
 *   runTreeSearch(brain, request, { verifier, breadth: 3 });
 *
 * Design points:
 *   - Caller owns the shape. We don't ship JSON Schema (no ajv dep) —
 *     a `requiredFields` allowlist + optional predicate is enough for
 *     >90% of structured-output tasks and stays in one file.
 *   - Extraction is permissive: prefer a ```json fenced block, fall back
 *     to ``` with no tag, then to a brace-balanced scan over the raw
 *     content. Models that follow a "JSON only" instruction emit raw;
 *     debate Revise output often wraps it in commentary like
 *     "Here's the JSON: { ... }".
 *   - Brace-balanced scan walks the longest balanced object, ignoring
 *     braces inside string literals (handles escaped quotes). Arrays
 *     at the top level are opt-in via allowArray.
 *   - Failure reasons list missing fields explicitly so the Reflexion
 *     log tells the next candidate exactly what was wrong.
 *
 * What this verifier is NOT:
 *   - A full JSON Schema validator. Add ajv in a dedicated slice if a
 *     real consumer needs it; for now the predicate hook handles
 *     anything beyond field presence.
 *   - A semantic checker. "{intent:'wrong'}" passes; only the caller's
 *     predicate knows if 'wrong' is valid.
 */

import { createLogger } from '../shared/logger.js';
import type { BrainResponse, BrainRequest } from './types.js';
import type { VerifierResult } from './brain-tree-search.js';

const log = createLogger('brain-verifier-schema');

/** Predicate verdict. Boolean shorthand expands to {ok}. */
export type SchemaPredicateResult = boolean | { ok: boolean; reason?: string };

/** Options for makeSchemaVerifier. */
export interface SchemaVerifierOpts {
  /**
   * Top-level field names that must exist on the parsed object. Missing
   * fields → score 0.0 with a reason listing them. Empty array = no
   * field check (predicate-only mode).
   */
  requiredFields?: string[];
  /**
   * Optional shape check beyond field presence. Receives the parsed
   * JSON. Return `true` / `{ok:true}` to accept, `false` / `{ok:false}`
   * to reject. Throwing counts as rejection with the error message.
   */
  predicate?: (parsed: unknown) => SchemaPredicateResult;
  /**
   * Allow a JSON array at the top level. Default false — most schemas
   * want an object root.
   */
  allowArray?: boolean;
}

/**
 * Find the longest balanced top-level JSON literal in `content`. Walks
 * the string once, tracking brace/bracket depth and string-literal
 * state. Returns the substring on first success, '' if no balanced
 * literal is found.
 *
 * Exported for unit-testing the extraction half independently of the
 * verifier scoring.
 */
export function extractJsonFromCandidate(content: string, allowArray = false): string {
  const trimmed = content.trim();
  if (trimmed === '') return '';

  // Prefer a fenced ```json block (Revise output often emits one).
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const haystack = fenceMatch && typeof fenceMatch[1] === 'string' ? fenceMatch[1] : trimmed;

  const openChars = allowArray ? '{[' : '{';
  const closeFor: Record<string, string> = { '{': '}', '[': ']' };

  let start = 0;
  while (start < haystack.length) {
    const ch = haystack[start]!;
    if (!openChars.includes(ch)) { start++; continue; }

    let depth = 0;
    let inStr = false;
    let escape = false;
    let mismatchedAt = -1;
    let i = start;
    for (; i < haystack.length; i++) {
      const c = haystack[i]!;
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') { depth++; continue; }
      if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          // Confirm balance by character match: the opening at `start`
          // must close with closeFor[ch].
          if (c === closeFor[ch]) return haystack.slice(start, i + 1);
          // Mismatched bracket — skip past this region (avoid O(N²)
          // rescans of the same content on adversarial input).
          mismatchedAt = i;
          break;
        }
      }
    }
    // Advance past the longest scanned region we already proved invalid,
    // so a 100KB string of `{]` pairs runs in O(N), not O(N²).
    start = mismatchedAt >= 0 ? mismatchedAt + 1 : i + 1;
  }
  return '';
}

/** Build a Reflexion reason from missing/extra info. Soft-capped. */
function buildReason(prefix: string, detail: string): string {
  const MAX = 400;
  const tail = detail.length > MAX ? `${detail.slice(0, MAX)}…` : detail;
  return `${prefix}: ${tail}`;
}

/**
 * Returned verifier function — async signature matches
 * `TreeSearchOpts.verifier`. Errors during predicate evaluation are
 * caught and surfaced as a rejection with the error message in the
 * Reflexion reason, never thrown out (a throwing verifier would tear
 * down the whole tree-search run).
 */
export function makeSchemaVerifier(
  opts: SchemaVerifierOpts,
): (candidate: BrainResponse, request: BrainRequest) => Promise<VerifierResult> {
  const requiredFields = opts.requiredFields ?? [];
  const predicate = opts.predicate;
  const allowArray = opts.allowArray ?? false;

  return async function schemaVerify(candidate, _request) {
    const content = (candidate.content ?? '').trim();
    if (content === '') {
      return { score: 0.0, reason: 'schema: empty content' };
    }

    const literal = extractJsonFromCandidate(content, allowArray);
    if (literal === '') {
      return { score: 0.0, reason: 'schema: no JSON literal found in candidate' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(literal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { score: 0.0, reason: buildReason('schema: JSON parse failed', msg) };
    }

    if (parsed === null || (typeof parsed !== 'object')) {
      return { score: 0.0, reason: 'schema: parsed value is not an object or array' };
    }
    if (Array.isArray(parsed) && !allowArray) {
      return { score: 0.0, reason: 'schema: top-level array rejected (allowArray=false)' };
    }

    if (requiredFields.length > 0) {
      // Required-field check only applies to objects. An array root with
      // allowArray:true skips field presence and goes straight to the
      // caller's predicate.
      if (!Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const missing = requiredFields.filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
        if (missing.length > 0) {
          return { score: 0.0, reason: buildReason('schema: missing required fields', missing.join(', ')) };
        }
      }
    }

    if (predicate) {
      let verdict: SchemaPredicateResult;
      try {
        verdict = predicate(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'schema verifier: predicate threw');
        return { score: 0.0, reason: buildReason('schema: predicate threw', msg) };
      }
      // Reject async predicates explicitly. The SchemaPredicateResult type
      // forbids them at compile time but TS only enforces shape, so an
      // `async () => true` slips through with the entire body becoming a
      // Promise; without this guard the `verdict.ok` branch reads
      // `undefined` and silently returns "predicate rejected" instead of
      // surfacing the misconfiguration.
      if (verdict !== null && typeof (verdict as { then?: unknown }).then === 'function') {
        return {
          score: 0.0,
          reason: 'schema: predicate returned a Promise (async predicates are not supported)',
        };
      }
      const ok = typeof verdict === 'boolean' ? verdict : verdict.ok;
      if (!ok) {
        const reason = typeof verdict === 'object' && verdict.reason
          ? buildReason('schema: predicate rejected', verdict.reason)
          : 'schema: predicate rejected';
        return { score: 0.0, reason };
      }
    }

    log.info({ requiredFields: requiredFields.length, hasPredicate: !!predicate }, 'schema verifier: PASS');
    return { score: 1.0 };
  };
}
