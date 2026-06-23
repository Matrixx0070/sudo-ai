/**
 * @file json-repair.test.ts
 * @description Locks in the JSON repair layer for the weak-model tool-call
 * fallback path. The contract that matters: repairJson NEVER returns a string
 * that fails to parse, and tryParseJson recovers the common malformations
 * weaker models emit (fences, trailing commas, single quotes, Python literals,
 * unquoted keys, truncated tails) instead of silently dropping the call.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { repairJson, tryParseJson, isJsonRepairEnabled } from '../../src/core/tools/json-repair.js';

afterEach(() => {
  delete process.env['SUDO_JSON_REPAIR'];
});

describe('repairJson — only ever returns parseable JSON or null', () => {
  const malformed: Array<[string, string, unknown]> = [
    ['trailing comma (object)', '{"a":1,}', { a: 1 }],
    ['trailing comma (array)', '{"a":[1,2,]}', { a: [1, 2] }],
    ['single quotes', "{'name':'read','path':'x.ts'}", { name: 'read', path: 'x.ts' }],
    ['unquoted keys', '{name:"read",path:"x.ts"}', { name: 'read', path: 'x.ts' }],
    ['python literals', '{"ok":True,"bad":False,"x":None}', { ok: true, bad: false, x: null }],
    ['markdown fence', '```json\n{"a":1}\n```', { a: 1 }],
    ['bare fence', '```\n{"a":1}\n```', { a: 1 }],
    ['prose around json', 'Sure, here you go: {"a":1} hope that helps', { a: 1 }],
    ['smart quotes', '{“name”:“read”}', { name: 'read' }],
    ['truncated object', '{"name":"read","path":"x.ts"', { name: 'read', path: 'x.ts' }],
    ['truncated nested', '{"a":{"b":1', { a: { b: 1 } }],
    ['unterminated string', '{"name":"read', { name: 'read' }],
    ['truncated array', '{"items":[1,2,3', { items: [1, 2, 3] }],
  ];

  for (const [label, input, expected] of malformed) {
    it(`repairs: ${label}`, () => {
      const fixed = repairJson(input);
      expect(fixed, `should repair ${label}`).not.toBeNull();
      // The contract: whatever it returns must parse.
      const parsed = JSON.parse(fixed as string);
      expect(parsed).toEqual(expected);
    });
  }

  it('returns null on irreparable garbage', () => {
    expect(repairJson('this is not json at all !!!')).toBeNull();
    expect(repairJson('')).toBeNull();
    expect(repairJson('   ')).toBeNull();
  });

  it('leaves already-valid JSON intact', () => {
    const fixed = repairJson('{"a":1,"b":[2,3]}');
    expect(JSON.parse(fixed as string)).toEqual({ a: 1, b: [2, 3] });
  });
});

describe('tryParseJson', () => {
  it('reports repaired:false for clean JSON', () => {
    const r = tryParseJson<{ a: number }>('{"a":1}');
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(false);
    expect(r!.value).toEqual({ a: 1 });
  });

  it('reports repaired:true when a fix was applied', () => {
    const r = tryParseJson<{ a: number }>('{"a":1,}');
    expect(r).not.toBeNull();
    expect(r!.repaired).toBe(true);
    expect(r!.value).toEqual({ a: 1 });
  });

  it('returns null for unparseable input', () => {
    expect(tryParseJson('nonsense {{{')).toBeNull();
  });

  it('honours enableRepair=false (plain parse only)', () => {
    expect(tryParseJson('{"a":1,}', false)).toBeNull();
    const ok = tryParseJson('{"a":1}', false);
    expect(ok).not.toBeNull();
    expect(ok!.repaired).toBe(false);
  });
});

describe('isJsonRepairEnabled — default on, kill-switch off', () => {
  it('is on by default', () => {
    expect(isJsonRepairEnabled()).toBe(true);
  });
  it('is off when SUDO_JSON_REPAIR=0', () => {
    process.env['SUDO_JSON_REPAIR'] = '0';
    expect(isJsonRepairEnabled()).toBe(false);
  });
});
