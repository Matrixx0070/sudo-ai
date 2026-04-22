/**
 * tool-result-classifier.test.ts — Unit tests for isToolResultSuccess().
 *
 * Spec reference: docs/wave10c-spec.md §5 Builder B tests (TRC-1..TRC-12, minus dropped IDs).
 * Exactly 10 tests: TRC-1, TRC-2, TRC-4, TRC-5, TRC-7, TRC-8, TRC-9, TRC-10, TRC-11, TRC-12.
 * Edge additions: TRC-8b (error:undefined), TRC-10b (ok:true bare).
 */

import { describe, it, expect } from 'vitest';
import { isToolResultSuccess } from '../../src/core/agent/tool-result-classifier.js';

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
});
