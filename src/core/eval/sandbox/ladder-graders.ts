/**
 * @file ladder-graders.ts
 * @description Code graders for Verifiability Ladder rungs 0–1 (ADR-0002).
 *
 * Rung 0 (liveness / reply shape): non-empty, parseable, normalized text — the
 * #751 content-filter empty-STRING class is exactly what this must catch, so
 * grading runs on normalizeReplyText output, not the raw blocks.
 *
 * Rung 1 (tool-call contract): the model must emit a well-formed tool_use for
 * the declared tool — known name (surviving provider name-mangling, e.g. Grok's
 * dot→underscore), required params present, types correct after coercion.
 *
 * Every grader is PURE (no I/O, no LLM) and total: an unknown `expect` key is a
 * FAILURE, never a silent pass — an admission gate must not admit on a check it
 * did not understand.
 */

import type { IRContentBlock, IRToolUseBlock } from '../../../../shared-types/ir/v1.js';

export interface GradeOutcome {
  passed: boolean;
  detail: string;
}

/** Provider name-mangling tolerance: Grok sanitizes dots to underscores. */
function toolNameMatches(expected: string, actual: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[.\-_]/g, '');
  return norm(expected) === norm(actual);
}

function typeOfParam(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Loose value equality for `paramsInclude`: numbers may arrive as numeric
 * strings from providers that stringify tool args, so compare after coercion
 * — the strict type contract is asserted separately by `paramTypes`.
 */
function valueMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number' && typeof actual === 'string') return Number(actual) === expected;
  if (typeof expected === 'boolean' && typeof actual === 'string') return String(expected) === actual.toLowerCase();
  if (typeof expected === 'string' && typeof actual === 'string') {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** Rung 0 — grade the normalized reply text against one item's `expect`. */
export function gradeRung0(expect: Record<string, unknown>, text: string): GradeOutcome {
  const trimmed = text.trim();
  for (const [key, want] of Object.entries(expect)) {
    switch (key) {
      case 'nonEmpty':
        if (want === true && trimmed === '') return { passed: false, detail: 'empty reply' };
        break;
      case 'outputContains':
        if (typeof want !== 'string' || !trimmed.toLowerCase().includes(want.toLowerCase())) {
          return { passed: false, detail: `missing substring ${JSON.stringify(want)}` };
        }
        break;
      case 'outputMatches': {
        if (typeof want !== 'string') return { passed: false, detail: 'outputMatches must be a string regex' };
        let re: RegExp;
        try {
          re = new RegExp(want, 'i');
        } catch {
          return { passed: false, detail: `invalid regex ${JSON.stringify(want)}` };
        }
        if (!re.test(trimmed)) return { passed: false, detail: `no match for /${want}/` };
        break;
      }
      case 'jsonParses': {
        if (want !== true) break;
        // Tolerate a fenced block: providers often wrap JSON in ```json fences
        // even when told not to — that is a formatting nit, not a liveness fail.
        const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try {
          JSON.parse(unfenced);
        } catch {
          return { passed: false, detail: 'reply is not valid JSON' };
        }
        break;
      }
      default:
        return { passed: false, detail: `unknown rung-0 expect key '${key}'` };
    }
  }
  return { passed: true, detail: 'ok' };
}

/** First tool_use block in an IR response, if any. */
export function firstToolUse(blocks: IRContentBlock[]): IRToolUseBlock | null {
  for (const b of blocks) {
    if (b.type === 'tool_use') return b;
  }
  return null;
}

/** Rung 1 — grade the emitted tool call against one item's `expect`. */
export function gradeRung1(expect: Record<string, unknown>, blocks: IRContentBlock[]): GradeOutcome {
  const call = firstToolUse(blocks);
  if (call === null) return { passed: false, detail: 'no tool_use block emitted' };
  const input = call.input;

  for (const [key, want] of Object.entries(expect)) {
    switch (key) {
      case 'toolCalled':
        if (typeof want !== 'string' || !toolNameMatches(want, call.name)) {
          return { passed: false, detail: `called '${call.name}', expected '${String(want)}'` };
        }
        break;
      case 'paramsInclude': {
        if (want === null || typeof want !== 'object') {
          return { passed: false, detail: 'paramsInclude must be an object' };
        }
        for (const [p, v] of Object.entries(want as Record<string, unknown>)) {
          if (!(p in input)) return { passed: false, detail: `missing required param '${p}'` };
          if (!valueMatches(v, input[p])) {
            return {
              passed: false,
              detail: `param '${p}' = ${JSON.stringify(input[p])}, expected ${JSON.stringify(v)}`,
            };
          }
        }
        break;
      }
      case 'paramTypes': {
        if (want === null || typeof want !== 'object') {
          return { passed: false, detail: 'paramTypes must be an object' };
        }
        for (const [p, t] of Object.entries(want as Record<string, string>)) {
          if (!(p in input)) return { passed: false, detail: `missing typed param '${p}'` };
          const actual = typeOfParam(input[p]);
          if (actual !== t) {
            return { passed: false, detail: `param '${p}' is ${actual}, expected ${t}` };
          }
        }
        break;
      }
      default:
        return { passed: false, detail: `unknown rung-1 expect key '${key}'` };
    }
  }
  return { passed: true, detail: 'ok' };
}
