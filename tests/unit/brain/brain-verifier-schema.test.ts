/**
 * brain-verifier-schema — JSON-shape verifier unit tests.
 *
 * Pure-function suite: no sandbox, no brain. Drives every score path
 * deterministically from a single import.
 */

import { describe, it, expect } from 'vitest';
import {
  extractJsonFromCandidate,
  makeSchemaVerifier,
} from '../../../src/core/brain/brain-verifier-schema.js';
import type { BrainResponse, BrainRequest } from '../../../src/core/brain/types.js';

function mkResp(content: string): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
    model: 'ollama/kimi-k2.7-code:cloud',
    finishReason: 'stop',
  };
}

const REQ: BrainRequest = { messages: [{ role: 'user', content: 'demo' }] };

describe('extractJsonFromCandidate', () => {
  it('extracts a ```json fenced block', () => {
    const src = 'Here:\n```json\n{"a":1,"b":2}\n```\nDone.';
    expect(extractJsonFromCandidate(src)).toBe('{"a":1,"b":2}');
  });

  it('extracts a bare ``` fenced block', () => {
    const src = '```\n{"x":true}\n```';
    expect(extractJsonFromCandidate(src)).toBe('{"x":true}');
  });

  it('extracts a raw object embedded in prose', () => {
    const src = 'Sure, the answer is {"intent":"search","q":"foo"} — hope that helps.';
    expect(extractJsonFromCandidate(src)).toBe('{"intent":"search","q":"foo"}');
  });

  it('handles nested objects via brace-balanced scan', () => {
    const src = 'Output: {"a":{"b":{"c":1}},"d":2} trailing';
    expect(extractJsonFromCandidate(src)).toBe('{"a":{"b":{"c":1}},"d":2}');
  });

  it('ignores braces inside string literals', () => {
    const src = '{"msg":"this has {curly} braces inside","ok":true}';
    expect(extractJsonFromCandidate(src)).toBe(src);
  });

  it('handles escaped quotes inside strings', () => {
    const src = '{"q":"she said \\"hi\\" then left","ok":true}';
    expect(extractJsonFromCandidate(src)).toBe(src);
  });

  it('rejects top-level arrays by default', () => {
    expect(extractJsonFromCandidate('[1,2,3]')).toBe('');
  });

  it('accepts top-level arrays when allowArray=true', () => {
    expect(extractJsonFromCandidate('[1,2,3]', true)).toBe('[1,2,3]');
  });

  it('returns empty when nothing balances', () => {
    expect(extractJsonFromCandidate('no JSON here at all')).toBe('');
    expect(extractJsonFromCandidate('open { but never close')).toBe('');
    expect(extractJsonFromCandidate('')).toBe('');
    expect(extractJsonFromCandidate('   \n  ')).toBe('');
  });
});

describe('makeSchemaVerifier', () => {
  it('scores 1.0 when all required fields are present', async () => {
    const verify = makeSchemaVerifier({ requiredFields: ['intent', 'targets'] });
    const verdict = await verify(mkResp('{"intent":"go","targets":["a"]}'), REQ);
    expect(verdict.score).toBe(1.0);
    expect(verdict.reason).toBeUndefined();
  });

  it('scores 0.0 with explicit missing fields in reason', async () => {
    const verify = makeSchemaVerifier({ requiredFields: ['intent', 'targets', 'reason'] });
    const verdict = await verify(mkResp('{"intent":"go"}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/missing required fields/);
    expect(verdict.reason).toContain('targets');
    expect(verdict.reason).toContain('reason');
    expect(verdict.reason).not.toContain('intent');
  });

  it('scores 0.0 on JSON parse failure', async () => {
    const verify = makeSchemaVerifier({ requiredFields: ['x'] });
    const verdict = await verify(mkResp('{not: valid, json:}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/JSON parse failed/);
  });

  it('scores 0.0 when no JSON literal is present', async () => {
    const verify = makeSchemaVerifier({ requiredFields: ['x'] });
    const verdict = await verify(mkResp('I cannot help with that.'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/no JSON literal/);
  });

  it('scores 0.0 on empty candidate', async () => {
    const verify = makeSchemaVerifier({});
    const verdict = await verify(mkResp(''), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/empty content/);
  });

  it('runs the predicate and accepts on truthy verdict', async () => {
    const verify = makeSchemaVerifier({
      predicate: (j) => Array.isArray((j as { items: unknown }).items),
    });
    const verdict = await verify(mkResp('{"items":[1,2]}'), REQ);
    expect(verdict.score).toBe(1.0);
  });

  it('runs the predicate and rejects with caller reason', async () => {
    const verify = makeSchemaVerifier({
      predicate: (j) => {
        const items = (j as { items: unknown }).items;
        if (!Array.isArray(items)) return { ok: false, reason: 'items not an array' };
        return true;
      },
    });
    const verdict = await verify(mkResp('{"items":"not-array"}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/predicate rejected/);
    expect(verdict.reason).toContain('items not an array');
  });

  it('catches predicate throws and surfaces the message', async () => {
    const verify = makeSchemaVerifier({
      predicate: () => { throw new Error('boom'); },
    });
    const verdict = await verify(mkResp('{"a":1}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/predicate threw/);
    expect(verdict.reason).toContain('boom');
  });

  it('rejects top-level array unless allowArray=true', async () => {
    const strict = makeSchemaVerifier({});
    const lax = makeSchemaVerifier({ allowArray: true });
    expect((await strict(mkResp('[1,2,3]'), REQ)).score).toBe(0.0);
    expect((await lax(mkResp('[1,2,3]'), REQ)).score).toBe(1.0);
  });

  it('skips field presence when the root is an array and allowArray=true', async () => {
    const verify = makeSchemaVerifier({
      requiredFields: ['intent'], // ignored for arrays
      allowArray: true,
      predicate: (j) => Array.isArray(j) && j.length === 3,
    });
    expect((await verify(mkResp('[1,2,3]'), REQ)).score).toBe(1.0);
    expect((await verify(mkResp('[1,2]'), REQ)).score).toBe(0.0);
  });

  it('extracts the first balanced object even when null fields and bare null follow', async () => {
    const verify = makeSchemaVerifier({});
    const verdict = await verify(mkResp('{"v":null}\n\nplus null on its own: null'), REQ);
    expect(verdict.score).toBe(1.0);
  });

  it('rejects a bare `null` candidate as non-object/non-array', async () => {
    const verify = makeSchemaVerifier({});
    const verdict = await verify(mkResp('null'), REQ);
    expect(verdict.score).toBe(0.0);
    // Bare `null` has no `{` or `[` so the brace-balanced scan returns ''
    // before the not-an-object guard ever fires.
    expect(verdict.reason).toMatch(/no JSON literal/);
  });

  it('rejects an async predicate with an explicit reason (does not silently fail)', async () => {
    const verify = makeSchemaVerifier({
      // TS type forbids this but a caller can still pass it; we reject at
      // runtime rather than silently treating the Promise as a rejection.
      predicate: (async () => true) as unknown as (p: unknown) => boolean,
    });
    const verdict = await verify(mkResp('{"a":1}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/async predicates are not supported/);
  });

  it('runs in linear time on adversarial mismatched-bracket input', async () => {
    const verify = makeSchemaVerifier({});
    // 5000 `{]` pairs — quadratic would be ~25M iterations; linear is 10K.
    const adversarial = '{]'.repeat(5000);
    const t0 = Date.now();
    const verdict = await verify(mkResp(adversarial), REQ);
    const ms = Date.now() - t0;
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/no JSON literal/);
    // Generous cap to avoid CI flake; quadratic would exceed this easily.
    expect(ms).toBeLessThan(1000);
  });

  it('handles an empty predicate-only verifier', async () => {
    const verify = makeSchemaVerifier({});
    expect((await verify(mkResp('{"any":"object"}'), REQ)).score).toBe(1.0);
  });

  it('soft-caps long predicate-rejection reasons', async () => {
    const huge = 'x'.repeat(2000);
    const verify = makeSchemaVerifier({
      predicate: () => ({ ok: false, reason: huge }),
    });
    const verdict = await verify(mkResp('{"a":1}'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason!.length).toBeLessThan(500);
    expect(verdict.reason).toMatch(/…$/);
  });
});
