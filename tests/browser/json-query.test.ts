/**
 * @file tests/browser/json-query.test.ts
 * @description Tests for the safe jq-subset used by browser.fetch jsonQuery —
 *   lets the agent extract from a huge JSON response instead of reasoning over
 *   a truncated blob (the Node.js-LTS failure).
 */

import { describe, it, expect } from 'vitest';
import { evaluateJsonQuery, JsonQueryError } from '../../src/core/tools/builtin/browser/json-query.js';

describe('evaluateJsonQuery', () => {
  it('navigates object/array paths', () => {
    const data = { a: { b: [{ c: 42 }] } };
    expect(evaluateJsonQuery(data, '.a.b[0].c')).toBe(42);
    expect(evaluateJsonQuery(data, '.a.b')).toEqual([{ c: 42 }]);
  });

  it('select(.k) keeps truthy-field elements; first/last/length reduce', () => {
    const arr = [{ v: 'x', lts: false }, { v: 'y', lts: 'Krypton' }, { v: 'z', lts: 'Jod' }];
    expect(evaluateJsonQuery(arr, 'select(.lts)')).toEqual([{ v: 'y', lts: 'Krypton' }, { v: 'z', lts: 'Jod' }]);
    expect(evaluateJsonQuery(arr, 'select(.lts) | first')).toEqual({ v: 'y', lts: 'Krypton' });
    expect(evaluateJsonQuery(arr, 'select(.lts) | last | .v')).toBe('z');
    expect(evaluateJsonQuery(arr, 'select(.lts) | length')).toBe(2);
  });

  it('select equality/inequality with string, number, bool literals', () => {
    const arr = [{ n: 1, ok: true }, { n: 2, ok: false }, { n: 3, ok: true }];
    expect(evaluateJsonQuery(arr, 'select(.n == 2)')).toEqual([{ n: 2, ok: false }]);
    expect(evaluateJsonQuery(arr, 'select(.ok == true) | length')).toBe(2);
    expect(evaluateJsonQuery(arr, 'select(.ok != true) | first | .n')).toBe(2);
  });

  it('map projects a field; keys lists object keys', () => {
    const arr = [{ v: 'a' }, { v: 'b' }];
    expect(evaluateJsonQuery(arr, 'map(.v)')).toEqual(['a', 'b']);
    expect(evaluateJsonQuery({ z: 1, a: 2 }, 'keys')).toEqual(['a', 'z']);
  });

  it('THE Node.js LTS case: newest-first list → latest LTS version', () => {
    // Mirrors nodejs.org/dist/index.json shape (newest-first; lts is false or a codename).
    const dist = [
      { version: 'v26.4.0', lts: false },
      { version: 'v25.9.0', lts: false },
      { version: 'v24.18.0', lts: 'Krypton' },   // ← the correct latest LTS
      { version: 'v24.17.0', lts: 'Krypton' },
      { version: 'v22.23.1', lts: 'Jod' },
    ];
    expect(evaluateJsonQuery(dist, 'select(.lts) | first | .version')).toBe('v24.18.0');
    expect(evaluateJsonQuery(dist, 'select(.lts) | first')).toEqual({ version: 'v24.18.0', lts: 'Krypton' });
  });

  it('throws JsonQueryError on malformed queries and type mismatches', () => {
    expect(() => evaluateJsonQuery({}, '')).toThrow(JsonQueryError);
    expect(() => evaluateJsonQuery({ a: 1 }, 'select(.a)')).toThrow(/expects an array/);
    expect(() => evaluateJsonQuery([1, 2], 'bogus_stage')).toThrow(/unknown query stage/);
    expect(() => evaluateJsonQuery([], 'first')).not.toThrow(); // empty array → undefined, not an error
  });

  it('does not evaluate code — a query is data, never executed', () => {
    // A "query" that looks like code is just an unknown stage, not run.
    expect(() => evaluateJsonQuery({}, 'process.exit(1)')).toThrow(JsonQueryError);
  });
});
