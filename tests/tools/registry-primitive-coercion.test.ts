/**
 * Tests for declared-primitive argument coercion in the tool registry.
 *
 * Live-observed bug class: models emit declared-primitive arguments as
 * STRINGS. Instance 1 (booleans): {"dryRun": "false"} on a declared
 * type:'boolean' param; `params['dryRun'] !== false` held true for the
 * STRING, so skill.install ran four times all forced into dryRun mode.
 * Instance 2 (numbers): {"amount": "500"} on a declared type:'number' param
 * passed finance.bookkeeper's `amount <= 0` guard (relational coercion),
 * PERSISTED the string into the ledger file, and every subsequent balance /
 * trial-balance call crashed on `.toFixed is not a function` until the file
 * was hand-edited. The registry now coerces strictly parseable strings on
 * declared boolean/number params before execution.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, coerceDeclaredPrimitives } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'test-session' } as ToolContext;

function probeTool(received: { params?: Record<string, unknown> }): ToolDefinition {
  return {
    name: 'test.primitive-probe',
    description: 'records received params',
    category: 'meta' as ToolDefinition['category'],
    parameters: {
      dryRun: { type: 'boolean', description: 'declared boolean', default: true },
      amount: { type: 'number', description: 'declared number' },
      label: { type: 'string', description: 'declared string' },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      received.params = params;
      return { success: true, output: 'ok', data: {} };
    },
  };
}

describe('coerceDeclaredPrimitives — booleans (unit)', () => {
  const tool = { parameters: { dryRun: { type: 'boolean' as const, description: '' } } };

  it('converts "false"/"true" strings on declared-boolean params', () => {
    expect(coerceDeclaredPrimitives(tool, { dryRun: 'false' })['dryRun']).toBe(false);
    expect(coerceDeclaredPrimitives(tool, { dryRun: 'true' })['dryRun']).toBe(true);
  });

  it('passes native booleans and unrelated values through untouched', () => {
    expect(coerceDeclaredPrimitives(tool, { dryRun: false })['dryRun']).toBe(false);
    expect(coerceDeclaredPrimitives(tool, { dryRun: true })['dryRun']).toBe(true);
    expect(coerceDeclaredPrimitives(tool, { dryRun: 'FALSE' })['dryRun']).toBe('FALSE');
    expect(coerceDeclaredPrimitives(tool, {})['dryRun']).toBeUndefined();
  });

  it('does not touch string-typed params and does not mutate the input', () => {
    const t = { parameters: { label: { type: 'string' as const, description: '' } } };
    const input = { label: 'false' };
    const out = coerceDeclaredPrimitives(t, input);
    expect(out['label']).toBe('false');
    expect(out).toBe(input); // no copy when nothing coerced
    const t2 = { parameters: { dryRun: { type: 'boolean' as const, description: '' } } };
    const input2 = { dryRun: 'false' };
    const out2 = coerceDeclaredPrimitives(t2, input2);
    expect(input2.dryRun).toBe('false'); // original untouched
    expect(out2).not.toBe(input2);
  });
});

describe('coerceDeclaredPrimitives — numbers (unit)', () => {
  const tool = { parameters: { amount: { type: 'number' as const, description: '' } } };

  it('converts strictly parseable numeric strings on declared-number params', () => {
    expect(coerceDeclaredPrimitives(tool, { amount: '500' })['amount']).toBe(500);
    expect(coerceDeclaredPrimitives(tool, { amount: '-1.5' })['amount']).toBe(-1.5);
    expect(coerceDeclaredPrimitives(tool, { amount: '2e3' })['amount']).toBe(2000);
    expect(coerceDeclaredPrimitives(tool, { amount: ' 42 ' })['amount']).toBe(42);
    expect(coerceDeclaredPrimitives(tool, { amount: '0' })['amount']).toBe(0);
  });

  it('pins Number() edge forms as DELIBERATELY accepted (same as existing per-tool Number() calls)', () => {
    expect(coerceDeclaredPrimitives(tool, { amount: '0x10' })['amount']).toBe(16);
    expect(coerceDeclaredPrimitives(tool, { amount: '+5' })['amount']).toBe(5);
  });

  it('leaves non-parseable strings for the tool\'s own validation', () => {
    expect(coerceDeclaredPrimitives(tool, { amount: '' })['amount']).toBe('');
    expect(coerceDeclaredPrimitives(tool, { amount: '  ' })['amount']).toBe('  ');
    expect(coerceDeclaredPrimitives(tool, { amount: '5px' })['amount']).toBe('5px');
    expect(coerceDeclaredPrimitives(tool, { amount: 'NaN' })['amount']).toBe('NaN');
    expect(coerceDeclaredPrimitives(tool, { amount: 'Infinity' })['amount']).toBe('Infinity');
    expect(coerceDeclaredPrimitives(tool, { amount: '1,000' })['amount']).toBe('1,000');
  });

  it('passes native numbers and non-string values through untouched', () => {
    const input = { amount: 500 };
    expect(coerceDeclaredPrimitives(tool, input)).toBe(input); // no copy
    expect(coerceDeclaredPrimitives(tool, { amount: null })['amount']).toBeNull();
    expect(coerceDeclaredPrimitives(tool, {})['amount']).toBeUndefined();
  });

  it('string params that look numeric are NOT coerced', () => {
    const t = { parameters: { zip: { type: 'string' as const, description: '' } } };
    expect(coerceDeclaredPrimitives(t, { zip: '02134' })['zip']).toBe('02134');
  });
});

describe('coerceDeclaredPrimitives — nested members (unit)', () => {
  const tool = {
    parameters: {
      operations: {
        type: 'array' as const,
        description: '',
        items: {
          type: 'object' as const,
          description: '',
          properties: {
            width: { type: 'number' as const, description: '' },
            label: { type: 'string' as const, description: '' },
            enabled: { type: 'boolean' as const, description: '' },
          },
        },
      },
    },
  };

  it('coerces number/boolean strings inside array-of-object members', () => {
    const out = coerceDeclaredPrimitives(tool, {
      operations: [{ width: '300', label: '300', enabled: 'true' }, { width: 200 }],
    });
    const ops = out['operations'] as Array<Record<string, unknown>>;
    expect(ops[0]).toEqual({ width: 300, label: '300', enabled: true }); // declared string untouched
    expect(ops[1]).toEqual({ width: 200 });
  });

  it('leaves undeclared members and non-parseable strings alone', () => {
    const out = coerceDeclaredPrimitives(tool, {
      operations: [{ width: '5px', extra: '7' }],
    });
    expect((out['operations'] as Array<Record<string, unknown>>)[0]).toEqual({ width: '5px', extra: '7' });
  });

  it('no-copy fast path: untouched nested structures keep identity', () => {
    const input = { operations: [{ width: 300, label: 'x' }] };
    const out = coerceDeclaredPrimitives(tool, input);
    expect(out).toBe(input);
    expect(out['operations']).toBe(input.operations);
  });

  it('does not mutate the original nested objects when coercing', () => {
    const inner = { width: '300' };
    const input = { operations: [inner] };
    const out = coerceDeclaredPrimitives(tool, input);
    expect(inner.width).toBe('300'); // original untouched
    expect((out['operations'] as Array<Record<string, unknown>>)[0]!['width']).toBe(300);
  });

  it('coerces arrays of bare number items', () => {
    const t = { parameters: { sizes: { type: 'array' as const, description: '', items: { type: 'number' as const, description: '' } } } };
    expect(coerceDeclaredPrimitives(t, { sizes: ['1', 2, '3.5'] })['sizes']).toEqual([1, 2, 3.5]);
  });

  it('coerces top-level objects with declared primitive properties (margins shape)', () => {
    const t = {
      parameters: {
        margins: {
          type: 'object' as const, description: '',
          properties: {
            top: { type: 'number' as const, description: '' },
            bottom: { type: 'number' as const, description: '' },
          },
        },
      },
    };
    expect(coerceDeclaredPrimitives(t, { margins: { top: '10', bottom: 20 } })['margins'])
      .toEqual({ top: 10, bottom: 20 });
  });

  it('junk elements inside a declared items:object array pass through untouched', () => {
    const out = coerceDeclaredPrimitives(tool, { operations: [null, 'x', 5, { width: '300' }] });
    expect(out['operations']).toEqual([null, 'x', 5, { width: 300 }]);
  });

  it('coerces the deepest real builtin shape — github files[].edits[].all at depth 4', () => {
    // Mirrors github.ts files[].edits[].all; consumer checks `e?.all === true`,
    // so a string "true" silently degraded to replace-first-occurrence.
    const gh = {
      parameters: {
        files: {
          type: 'array' as const, description: '',
          items: {
            type: 'object' as const, description: '',
            properties: {
              edits: {
                type: 'array' as const, description: '',
                items: {
                  type: 'object' as const, description: '',
                  properties: { all: { type: 'boolean' as const, description: '' } },
                },
              },
            },
          },
        },
      },
    };
    const out = coerceDeclaredPrimitives(gh, { files: [{ edits: [{ all: 'true' }] }] });
    expect((out['files'] as Array<{ edits: Array<{ all: unknown }> }>)[0]!.edits[0]!.all).toBe(true);
  });

  it('stops at the depth cap instead of recursing forever', () => {
    // leaf at recursion depth 6 (== MAX_COERCE_DEPTH): blocked; depth 5 coerces.
    const leafAt = (levels: number): { params: Record<string, never>; spec: Record<string, unknown> } => {
      let spec: Record<string, unknown> = { type: 'number', description: '' };
      let value: unknown = '5';
      for (let i = 0; i < levels; i++) {
        spec = { type: 'object', description: '', properties: { k: spec } };
        value = { k: value };
      }
      return { spec: { parameters: { root: spec } }, params: { root: value } as never };
    };
    const dig = (v: unknown, levels: number): unknown => {
      for (let i = 0; i < levels; i++) v = (v as { k: unknown }).k;
      return v;
    };
    const blocked = leafAt(6); // root visited at depth 0, leaf at depth 6
    const outBlocked = coerceDeclaredPrimitives(blocked.spec as never, blocked.params);
    expect(dig(outBlocked['root'], 6)).toBe('5');
    const allowed = leafAt(5);
    const outAllowed = coerceDeclaredPrimitives(allowed.spec as never, allowed.params);
    expect(dig(outAllowed['root'], 5)).toBe(5);
  });
});

describe('registry.execute applies primitive coercion', () => {
  it('tool receives real primitives when the model sent strings', async () => {
    const received: { params?: Record<string, unknown> } = {};
    const registry = new ToolRegistry();
    registry.register(probeTool(received));
    await registry.execute(
      'test.primitive-probe',
      { dryRun: 'false', amount: '500', label: 'false' },
      ctx,
    );
    expect(received.params?.['dryRun']).toBe(false);
    expect(received.params?.['amount']).toBe(500);
    expect(received.params?.['label']).toBe('false'); // string param untouched
  });
});

describe('stringified object/array coercion (2026-07-24 browser.scrape incident)', () => {
  const objTool: ToolDefinition = {
    name: 'test.object-probe',
    description: 'declared object + array params',
    category: 'meta' as ToolDefinition['category'],
    parameters: {
      selectors: { type: 'object', description: 'field→selector map', properties: {} },
      ops: {
        type: 'array',
        description: 'operations',
        items: { type: 'object', description: 'op', properties: { width: { type: 'number', description: 'w' } } },
      },
      note: { type: 'string', description: 'declared string' },
    },
    async execute(): Promise<ToolResult> { return { success: true, output: 'ok', data: {} }; },
  };

  it('parses a stringified object for a declared object param (the incident payload)', () => {
    const out = coerceDeclaredPrimitives(objTool, {
      selectors: '{"scores": ".score", "titles": ".titleline"}',
    });
    expect(out['selectors']).toEqual({ scores: '.score', titles: '.titleline' });
  });

  it('parses a stringified array AND coerces nested declared primitives inside it', () => {
    const out = coerceDeclaredPrimitives(objTool, { ops: '[{"width": "300"}]' });
    expect(out['ops']).toEqual([{ width: 300 }]);
  });

  it('leaves non-JSON strings on object params untouched (tool validates)', () => {
    const out = coerceDeclaredPrimitives(objTool, { selectors: 'div.title' });
    expect(out['selectors']).toBe('div.title');
  });

  it('leaves malformed JSON untouched', () => {
    const out = coerceDeclaredPrimitives(objTool, { selectors: '{"a": ' });
    expect(out['selectors']).toBe('{"a": ');
  });

  it('does NOT parse JSON-looking strings on declared string params', () => {
    const out = coerceDeclaredPrimitives(objTool, { note: '{"keep": "as-string"}' });
    expect(out['note']).toBe('{"keep": "as-string"}');
  });

  it('rejects shape mismatch: array string on object param stays a string', () => {
    const out = coerceDeclaredPrimitives(objTool, { selectors: '["not", "a", "map"]' });
    expect(out['selectors']).toBe('["not", "a", "map"]');
  });
});
