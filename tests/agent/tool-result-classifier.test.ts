/**
 * tool-result-classifier.test.ts — Unit tests for isToolResultSuccess().
 *
 * Spec reference: docs/wave10c-spec.md §5 Builder B tests (TRC-1..TRC-12, minus dropped IDs).
 * Exactly 10 tests: TRC-1, TRC-2, TRC-4, TRC-5, TRC-7, TRC-8, TRC-9, TRC-10, TRC-11, TRC-12.
 * Edge additions: TRC-8b (error:undefined), TRC-10b (ok:true bare).
 */

import { describe, it, expect } from 'vitest';
import { isToolResultSuccess, resolveToolSuccess } from '../../src/core/agent/tool-result-classifier.js';

describe('isToolResultSuccess', () => {
  // TRC-1 — null → true
  it('TRC-1: null returns true', () => {
    expect(isToolResultSuccess(null)).toBe(true);
  });

  // TRC-2 — undefined → true
  it('TRC-2: undefined returns true', () => {
    expect(isToolResultSuccess(undefined)).toBe(true);
  });

  // TRC-4 — 'Error: something' → false (uppercase Error prefix)
  it('TRC-4: string starting with "Error:" returns false', () => {
    expect(isToolResultSuccess('Error: something went wrong')).toBe(false);
  });

  // TRC-5 — 'error: something' → false (lowercase error prefix)
  it('TRC-5: string starting with lowercase "error:" returns false', () => {
    expect(isToolResultSuccess('error: something went wrong')).toBe(false);
  });

  // TRC-7 — {error: 'not found'} → false
  it('TRC-7: object with non-null error field returns false', () => {
    expect(isToolResultSuccess({ error: 'not found' })).toBe(false);
  });

  // TRC-8 — {error: null} → true (null error sentinel = no error)
  it('TRC-8: object with null error field returns true', () => {
    expect(isToolResultSuccess({ error: null })).toBe(true);
  });

  // TRC-8b — {error: undefined} → true (undefined != null is false, so treated as no error)
  // Rule 6: r['error'] != null — both null and undefined satisfy this check as "no error"
  it('TRC-8b: object with error key explicitly set to undefined returns true', () => {
    expect(isToolResultSuccess({ error: undefined })).toBe(true);
  });

  // TRC-9 — {ok: false} → false
  it('TRC-9: object with ok=false returns false', () => {
    expect(isToolResultSuccess({ ok: false })).toBe(false);
  });

  // TRC-10 — {ok: true, data: 'result'} → true
  it('TRC-10: object with ok=true returns true', () => {
    expect(isToolResultSuccess({ ok: true, data: 'result' })).toBe(true);
  });

  // TRC-10b — {ok: true} bare (no other fields) → true
  it('TRC-10b: object with ok=true and no other fields returns true', () => {
    expect(isToolResultSuccess({ ok: true })).toBe(true);
  });

  // TRC-11 — {result: 'ok'} (no error/ok key) → true
  it('TRC-11: object with no error/ok key returns true', () => {
    expect(isToolResultSuccess({ result: 'ok' })).toBe(true);
  });

  // TRC-12 — false (boolean) → false
  it('TRC-12: boolean false returns false', () => {
    expect(isToolResultSuccess(false)).toBe(false);
  });

  // TRC-13 — honor the canonical ToolResult.success field (was previously ignored,
  // so a self-reported failure with no `error` field was mislabeled as success).
  it('TRC-13: object with success=false returns false even without an error field', () => {
    expect(isToolResultSuccess({ success: false, output: 'No matching records found' })).toBe(false);
  });
  it('TRC-13b: object with success=true returns true', () => {
    expect(isToolResultSuccess({ success: true, output: '' })).toBe(true);
  });
});

describe('resolveToolSuccess — authoritative success over string re-guessing', () => {
  // The loop emits `result` as the tool's OUTPUT STRING; the event also carries
  // the tool's authoritative `success`. resolveToolSuccess must prefer it.
  it('RTS-1: authoritative success=false overrides a non-error-looking output string', () => {
    // This is the core fix: previously classified as success (string doesn't start with "error").
    expect(resolveToolSuccess({ success: false, result: 'No matching records found' })).toBe(false);
  });
  it('RTS-2: authoritative success=true overrides a scary-looking output string', () => {
    expect(resolveToolSuccess({ success: true, result: 'Error-looking text the tool says is fine' })).toBe(true);
  });
  it('RTS-3: no authoritative success → falls back to string classification (positive)', () => {
    expect(resolveToolSuccess({ result: 'plain successful output' })).toBe(true);
  });
  it('RTS-4: no authoritative success → falls back to string classification (negative)', () => {
    expect(resolveToolSuccess({ result: 'error: boom' })).toBe(false);
  });
  it('RTS-5: no authoritative success, object result → classifier honors its success field', () => {
    expect(resolveToolSuccess({ result: { success: false, output: 'x' } })).toBe(false);
  });
});
