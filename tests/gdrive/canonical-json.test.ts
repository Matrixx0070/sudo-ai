import { describe, it, expect } from 'vitest';
import { canonicalJson, CanonicalJsonError } from '../../src/core/gdrive/canonical-json.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is key-order independent (HMAC stability)', () => {
    const a = { x: 1, y: [{ b: 2, a: 3 }], z: 'e' };
    const b = { z: 'e', y: [{ a: 3, b: 2 }], x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('drops undefined-valued keys (JSON.stringify parity) but keeps nulls', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined, null])).toBe('[null,null]');
  });

  it('handles strings, numbers, booleans, empty containers', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(0.5)).toBe('0.5');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
  });

  it('rejects non-finite numbers and cycles', () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalJsonError);
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => canonicalJson(cyc)).toThrow(/circular/);
  });

  it('allows repeated (non-cyclic) references', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});
