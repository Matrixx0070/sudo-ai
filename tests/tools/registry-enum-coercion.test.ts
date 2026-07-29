/**
 * Tests for declared-enum string canonicalization in the tool registry.
 *
 * Same live bug class as registry-primitive-coercion: models emit enum values
 * with the wrong case or stray whitespace ({"priority": "High"} on a declared
 * enum:["high","medium","low"]), which the tool's own enum validation then
 * rejects even though the intent is unambiguous. The registry now coerces an
 * off-enum string that matches exactly ONE entry after trim + case-fold to
 * the canonical enum entry. Deliberately NOT fuzzy: no edit-distance or
 * prefix matching — ambiguous or unmatched values pass through untouched so
 * the existing error path still fires.
 */
import { describe, it, expect } from 'vitest';
import {
  ToolRegistry,
  coerceDeclaredPrimitives,
  coerceJsonSchemaPrimitives,
} from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'test-session' } as ToolContext;

describe('coerceDeclaredPrimitives — enum canonicalization (unit)', () => {
  const tool = {
    parameters: {
      priority: { type: 'string' as const, description: '', enum: ['high', 'medium', 'low'] },
    },
  };

  it('coerces case-insensitive matches to the canonical entry', () => {
    expect(coerceDeclaredPrimitives(tool, { priority: 'High' })['priority']).toBe('high');
    expect(coerceDeclaredPrimitives(tool, { priority: 'MEDIUM' })['priority']).toBe('medium');
  });

  it('coerces whitespace-padded matches', () => {
    expect(coerceDeclaredPrimitives(tool, { priority: ' low ' })['priority']).toBe('low');
    expect(coerceDeclaredPrimitives(tool, { priority: '\thigh\n' })['priority']).toBe('high');
  });

  it('coerces combined case + whitespace variants', () => {
    expect(coerceDeclaredPrimitives(tool, { priority: '  HIGH ' })['priority']).toBe('high');
  });

  it('exact enum values pass through untouched (no copy)', () => {
    const input = { priority: 'high' };
    expect(coerceDeclaredPrimitives(tool, input)).toBe(input);
  });

  it('never fuzzy-matches: unmatched values are left for the error path', () => {
    expect(coerceDeclaredPrimitives(tool, { priority: 'hgh' })['priority']).toBe('hgh');
    expect(coerceDeclaredPrimitives(tool, { priority: 'highest' })['priority']).toBe('highest');
    expect(coerceDeclaredPrimitives(tool, { priority: 'hi gh' })['priority']).toBe('hi gh');
  });

  it('ambiguous normalized matches are left untouched', () => {
    const t = { parameters: { mode: { type: 'string' as const, description: '', enum: ['Fast', 'fast'] } } };
    expect(coerceDeclaredPrimitives(t, { mode: 'FAST' })['mode']).toBe('FAST');
    // An exact entry is still fine even when its case-variants collide.
    expect(coerceDeclaredPrimitives(t, { mode: 'Fast' })['mode']).toBe('Fast');
  });

  it('non-string values and enum-less string params are untouched', () => {
    expect(coerceDeclaredPrimitives(tool, { priority: 5 })['priority']).toBe(5);
    const t = { parameters: { label: { type: 'string' as const, description: '' } } };
    expect(coerceDeclaredPrimitives(t, { label: ' High ' })['label']).toBe(' High ');
  });

  it('coerces enum members nested inside declared items/properties', () => {
    const t = {
      parameters: {
        ops: {
          type: 'array' as const,
          description: '',
          items: {
            type: 'object' as const,
            description: '',
            properties: {
              level: { type: 'string' as const, description: '', enum: ['debug', 'info'] },
            },
          },
        },
      },
    };
    const out = coerceDeclaredPrimitives(t, { ops: [{ level: 'INFO ' }, { level: 'debug' }] });
    expect(out['ops']).toEqual([{ level: 'info' }, { level: 'debug' }]);
  });

  it('does not mutate the input when coercing', () => {
    const input = { priority: 'High' };
    const out = coerceDeclaredPrimitives(tool, input);
    expect(input.priority).toBe('High');
    expect(out['priority']).toBe('high');
  });
});

describe('coerceJsonSchemaPrimitives — enum canonicalization (MCP path)', () => {
  const schema = {
    type: 'object',
    properties: {
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      count: { type: 'number' },
    },
  };

  it('coerces case/whitespace variants on declared string enums', () => {
    expect(coerceJsonSchemaPrimitives(schema, { priority: ' High ' })['priority']).toBe('high');
  });

  it('coerces enums on members without a declared type', () => {
    const s = { type: 'object', properties: { mode: { enum: ['on', 'off'] } } };
    expect(coerceJsonSchemaPrimitives(s, { mode: 'ON' })['mode']).toBe('on');
  });

  it('leaves exact / unmatched / non-string enum entries alone', () => {
    const input = { priority: 'high' };
    expect(coerceJsonSchemaPrimitives(schema, input)).toBe(input); // no copy
    expect(coerceJsonSchemaPrimitives(schema, { priority: 'urgent' })['priority']).toBe('urgent');
    const s = { type: 'object', properties: { n: { type: 'number', enum: [1, 2] } } };
    expect(coerceJsonSchemaPrimitives(s, { n: '1' })['n']).toBe(1); // number coercion, not enum
  });

  it('coerces enums nested in properties/items', () => {
    const s = {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: { type: 'object', properties: { level: { type: 'string', enum: ['debug', 'info'] } } },
        },
      },
    };
    expect(coerceJsonSchemaPrimitives(s, { ops: [{ level: 'Info' }] })['ops']).toEqual([{ level: 'info' }]);
  });
});

describe('registry.execute applies enum coercion', () => {
  it('tool receives the canonical enum value when the model sent a case variant', async () => {
    const received: { params?: Record<string, unknown> } = {};
    const tool: ToolDefinition = {
      name: 'test.enum-probe',
      description: 'records received params',
      category: 'meta' as ToolDefinition['category'],
      parameters: {
        priority: { type: 'string', description: 'declared enum', enum: ['high', 'medium', 'low'] },
      },
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        received.params = params;
        return { success: true, output: 'ok', data: {} };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    await registry.execute('test.enum-probe', { priority: ' High ' }, ctx);
    expect(received.params?.['priority']).toBe('high');
  });
});
