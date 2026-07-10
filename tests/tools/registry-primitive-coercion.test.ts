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

  it('stops at the depth cap instead of recursing forever', () => {
    // number declared 5 levels down (beyond MAX_COERCE_DEPTH 4): untouched.
    const deep = {
      parameters: {
        a: { type: 'object' as const, description: '', properties: {
          b: { type: 'object' as const, description: '', properties: {
            c: { type: 'object' as const, description: '', properties: {
              d: { type: 'object' as const, description: '', properties: {
                e: { type: 'number' as const, description: '' },
              } },
            } },
          } },
        } },
      },
    };
    const out = coerceDeclaredPrimitives(deep, { a: { b: { c: { d: { e: '5' } } } } });
    expect((out['a'] as never as { b: { c: { d: { e: unknown } } } }).b.c.d.e).toBe('5');
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
