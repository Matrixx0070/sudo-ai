/**
 * Tests for the concatenated-JSON-object splitter used in brain.ts
 * to handle LLMs (e.g. grok-3 via xai) that batch multiple tool
 * call argument objects into a single `arguments` string.
 *
 * Root cause: @ai-sdk/openai line 874 passes function.arguments as-is
 * (a string), and grok-3 concatenates all intended tool-call objects
 * into one string: `{...}{...}{...}`.  The old extractToolCalls guard
 * detected `typeof args !== 'object'` and defaulted to `{}`, silently
 * dropping ALL tool arguments.
 */

// vi.mock is NOT needed here — we only test a pure exported function.
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy AI SDK imports so the module loads without network calls
// ---------------------------------------------------------------------------
import { vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  tool: vi.fn((opts: unknown) => opts),
  jsonSchema: vi.fn((s: unknown) => s),
}));

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const p = vi.fn((id: string) => ({ modelId: id }));
    p.chat = vi.fn((id: string) => ({ modelId: id }));
    return p;
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn((id: string) => ({ modelId: id }))),
}));

import { splitConcatenatedJsonObjects } from '../../src/core/brain/brain.js';

// ---------------------------------------------------------------------------
// The exact concatenated string observed in the bug report
// ---------------------------------------------------------------------------
const BUG_REPORT_ARGS =
  '{"query":"latest AI news","maxResults":5}' +
  '{"code":"2 + 2","timeout":5000}' +
  '{"code":"print(\'Hello from sandbox\')","timeout":10000}' +
  '{"command":"uname -a"}' +
  '{"action":"search-code","searchText":"health-check","filePattern":"*.ts"}';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('splitConcatenatedJsonObjects', () => {
  // ---- normal single-object cases -----------------------------------------

  it('parses a single valid JSON object string', () => {
    const result = splitConcatenatedJsonObjects('{"query":"test","maxResults":5}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ query: 'test', maxResults: 5 });
  });

  it('returns empty array for an empty string', () => {
    expect(splitConcatenatedJsonObjects('')).toEqual([]);
  });

  it('returns empty array when string does not start with {', () => {
    expect(splitConcatenatedJsonObjects('"just a string"')).toEqual([]);
    expect(splitConcatenatedJsonObjects('null')).toEqual([]);
    expect(splitConcatenatedJsonObjects('42')).toEqual([]);
  });

  it('returns empty array for a malformed JSON string', () => {
    expect(splitConcatenatedJsonObjects('{bad json here')).toEqual([]);
  });

  it('handles whitespace around the object', () => {
    const result = splitConcatenatedJsonObjects('  {"a":1}  ');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ a: 1 });
  });

  it('handles an empty object {}', () => {
    const result = splitConcatenatedJsonObjects('{}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({});
  });

  // ---- concatenated-object cases ------------------------------------------

  it('splits two concatenated objects', () => {
    const result = splitConcatenatedJsonObjects('{"a":1}{"b":2}');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ a: 1 });
    expect(result[1]).toEqual({ b: 2 });
  });

  it('handles the exact bug-report 5-object concatenation', () => {
    const result = splitConcatenatedJsonObjects(BUG_REPORT_ARGS);
    // Should recover 5 objects
    expect(result).toHaveLength(5);

    // OLD behaviour: everything was dropped → args was {}
    // NEW behaviour: at least the first object is intact
    expect(result[0]).toEqual({ query: 'latest AI news', maxResults: 5 });
    expect(result[1]).toEqual({ code: '2 + 2', timeout: 5000 });
    expect(result[2]).toEqual({ code: "print('Hello from sandbox')", timeout: 10000 });
    expect(result[3]).toEqual({ command: 'uname -a' });
    expect(result[4]).toEqual({ action: 'search-code', searchText: 'health-check', filePattern: '*.ts' });
  });

  it('uses first object as args (Strategy A behaviour)', () => {
    // Simulate what extractToolCalls does: takes objects[0]
    const objects = splitConcatenatedJsonObjects(BUG_REPORT_ARGS);
    const chosenArgs = objects[0] ?? {};
    expect(chosenArgs).toEqual({ query: 'latest AI news', maxResults: 5 });
    // Contrast with old behaviour which returned {}
    expect(chosenArgs).not.toEqual({});
  });

  // ---- string-value robustness --------------------------------------------

  it('handles values that contain { and } inside strings', () => {
    const input = '{"template":"{value}","count":3}{"other":"a}{b"}';
    const result = splitConcatenatedJsonObjects(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ template: '{value}', count: 3 });
    expect(result[1]).toEqual({ other: 'a}{b' });
  });

  it('handles escaped quotes inside string values', () => {
    const input = '{"msg":"say \\"hello\\""}{"x":1}';
    const result = splitConcatenatedJsonObjects(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ msg: 'say "hello"' });
    expect(result[1]).toEqual({ x: 1 });
  });

  // ---- nested object values -----------------------------------------------

  it('handles nested objects correctly (only top-level boundaries split)', () => {
    const input = '{"nested":{"a":1,"b":2}}{"other":true}';
    const result = splitConcatenatedJsonObjects(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ nested: { a: 1, b: 2 } });
    expect(result[1]).toEqual({ other: true });
  });
});
