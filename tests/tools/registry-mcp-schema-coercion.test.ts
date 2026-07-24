/**
 * Tests for declared-primitive coercion on the MCP execution path.
 *
 * The registry's execute() short-circuits `mcp__*` names into
 * _executeMCPTool BEFORE the coerceDeclaredPrimitives call that protects
 * native tools, so a model emitting {"width": "300"} against an MCP tool
 * whose inputSchema declares `width: {type: "number"}` reached the MCP
 * server with the string intact — the same bug class fixed for native
 * tools (finance ledger poisoned by string "500"; sharp rejecting string
 * widths), one door over. MCP tools carry raw JSON Schema (`inputSchema`),
 * not the registry's ParamSpec map, so they need a JSON-Schema-shaped
 * walker: coerceJsonSchemaPrimitives.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, coerceJsonSchemaPrimitives } from '../../src/core/tools/registry.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { MCPAdapterLike, MCPToolDef } from '../../src/core/tools/mcp-adapter.js';

const ctx = { sessionId: 'test-session' } as ToolContext;

/** Minimal in-memory MCP adapter that records the args callTool receives. */
function fakeAdapter(
  serverId: string,
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>,
  received: { name?: string; args?: Record<string, unknown> },
): MCPAdapterLike {
  const defs: MCPToolDef[] = tools.map((t) => ({
    name: `mcp__${serverId}__${t.name}`,
    description: 'fake tool',
    inputSchema: t.inputSchema,
    serverId,
    enabled: true,
  }));
  return {
    serverId,
    connect: async () => {},
    disconnect: async () => {},
    listTools: async () => defs,
    getCachedTools: () => defs,
    callTool: async (name, args) => {
      received.name = name;
      received.args = args;
      return { content: 'ok' };
    },
  };
}

const RESIZE_SCHEMA = {
  type: 'object',
  properties: {
    width: { type: 'number', description: 'target width' },
    height: { type: 'integer', description: 'target height' },
    fullPage: { type: 'boolean', description: 'capture full page' },
    label: { type: 'string', description: 'declared string' },
  },
  required: ['width'],
};

describe('registry.execute applies JSON-Schema coercion on the MCP path', () => {
  it('MCP server receives real primitives when the model sent strings', async () => {
    const received: { name?: string; args?: Record<string, unknown> } = {};
    const registry = new ToolRegistry();
    const adapter = fakeAdapter('fake', [{ name: 'resize', inputSchema: RESIZE_SCHEMA }], received);
    registry.registerMCPSource(adapter, 'fake');

    const result = await registry.execute(
      'mcp__fake__resize',
      { width: '300', height: '200', fullPage: 'true', label: '300' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(received.args?.['width']).toBe(300);
    expect(received.args?.['height']).toBe(200);
    expect(received.args?.['fullPage']).toBe(true);
    expect(received.args?.['label']).toBe('300'); // declared string untouched
  });

  it('SUDO_MCP_SCHEMA_COERCE=0 disables coercion (server-misdeclared-schema escape hatch)', async () => {
    const received: { name?: string; args?: Record<string, unknown> } = {};
    const registry = new ToolRegistry();
    registry.registerMCPSource(
      fakeAdapter('fake', [{ name: 'resize', inputSchema: RESIZE_SCHEMA }], received),
      'fake',
    );
    process.env['SUDO_MCP_SCHEMA_COERCE'] = '0';
    try {
      await registry.execute('mcp__fake__resize', { width: '300' }, ctx);
    } finally {
      delete process.env['SUDO_MCP_SCHEMA_COERCE'];
    }
    expect(received.args?.['width']).toBe('300'); // untouched with the flag off
  });

  it('passes already-correct args through with identity preserved', async () => {
    const received: { name?: string; args?: Record<string, unknown> } = {};
    const registry = new ToolRegistry();
    registry.registerMCPSource(
      fakeAdapter('fake', [{ name: 'resize', inputSchema: RESIZE_SCHEMA }], received),
      'fake',
    );
    const args = { width: 300, label: 'x' };
    await registry.execute('mcp__fake__resize', args, ctx);
    expect(received.args).toBe(args); // no copy when nothing coerced
  });
});

describe('coerceJsonSchemaPrimitives (unit)', () => {
  it('coerces declared number/integer/boolean strings at the top level', () => {
    const out = coerceJsonSchemaPrimitives(RESIZE_SCHEMA, {
      width: '1.5', height: '42', fullPage: 'false', label: 'true',
    });
    expect(out).toEqual({ width: 1.5, height: 42, fullPage: false, label: 'true' });
  });

  it('integer members only convert on integral strings', () => {
    expect(coerceJsonSchemaPrimitives(RESIZE_SCHEMA, { height: '2.5' })['height']).toBe('2.5');
    expect(coerceJsonSchemaPrimitives(RESIZE_SCHEMA, { height: '-3' })['height']).toBe(-3);
  });

  it('leaves non-parseable strings for the server\'s own validation', () => {
    const out = coerceJsonSchemaPrimitives(RESIZE_SCHEMA, {
      width: '5px', height: 'NaN', fullPage: 'FALSE',
    });
    expect(out).toEqual({ width: '5px', height: 'NaN', fullPage: 'FALSE' });
  });

  it('never coerces when the declared type union admits string', () => {
    const schema = {
      type: 'object',
      properties: { v: { type: ['number', 'string'] }, w: { type: ['number', 'null'] } },
    };
    const out = coerceJsonSchemaPrimitives(schema, { v: '300', w: '300' });
    expect(out['v']).toBe('300'); // string is a legal type — hands off
    expect(out['w']).toBe(300); // string is NOT legal — coerce
  });

  it('recurses through declared items and nested properties', () => {
    const schema = {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              opts: { type: 'object', properties: { deep: { type: 'boolean' } } },
            },
          },
        },
      },
    };
    const out = coerceJsonSchemaPrimitives(schema, {
      operations: [{ width: '300', opts: { deep: 'true' }, extra: '7' }, { width: 200 }],
    });
    expect(out['operations']).toEqual([
      { width: 300, opts: { deep: true }, extra: '7' }, // undeclared member untouched
      { width: 200 },
    ]);
  });

  it('recurses into properties/items even when the parent omits an explicit type', () => {
    // Lax real-world schemas sometimes omit type:'object' but carry properties.
    const schema = { properties: { n: { type: 'number' } } };
    expect(coerceJsonSchemaPrimitives(schema, { n: '5' })['n']).toBe(5);
  });

  it('does not coerce without an explicit declared primitive type', () => {
    const schema = { type: 'object', properties: { n: {}, m: { description: 'no type' } } };
    const out = coerceJsonSchemaPrimitives(schema, { n: '5', m: 'true' });
    expect(out).toEqual({ n: '5', m: 'true' });
  });

  it('ignores tuple-form items, combinators, and malformed schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        tuple: { type: 'array', items: [{ type: 'number' }] }, // tuple form — skipped
        union: { anyOf: [{ type: 'number' }] }, // combinator — skipped
        junk: { type: 'array', items: 'nonsense' },
      },
    };
    const input = { tuple: ['1'], union: '2', junk: ['3'] };
    const out = coerceJsonSchemaPrimitives(schema, input);
    expect(out).toBe(input); // untouched, identity preserved
  });

  it('returns params unchanged for non-object or empty schemas', () => {
    const input = { width: '300' };
    expect(coerceJsonSchemaPrimitives({}, input)).toBe(input);
    expect(coerceJsonSchemaPrimitives(null, input)).toBe(input);
    expect(coerceJsonSchemaPrimitives('bogus', input)).toBe(input);
  });

  it('does not mutate the original nested structures when coercing', () => {
    const inner = { width: '300' };
    const input = { operations: [inner] };
    const schema = {
      type: 'object',
      properties: {
        operations: { type: 'array', items: { type: 'object', properties: { width: { type: 'number' } } } },
      },
    };
    const out = coerceJsonSchemaPrimitives(schema, input);
    expect(inner.width).toBe('300');
    expect((out['operations'] as Array<Record<string, unknown>>)[0]!['width']).toBe(300);
  });

  it('stops at the depth cap instead of recursing forever', () => {
    const leafAt = (levels: number): { schema: Record<string, unknown>; params: Record<string, unknown> } => {
      let spec: Record<string, unknown> = { type: 'number' };
      let value: unknown = '5';
      for (let i = 0; i < levels; i++) {
        spec = { type: 'object', properties: { k: spec } };
        value = { k: value };
      }
      return { schema: { type: 'object', properties: { root: spec } }, params: { root: value } };
    };
    const dig = (v: unknown, levels: number): unknown => {
      for (let i = 0; i < levels; i++) v = (v as { k: unknown }).k;
      return v;
    };
    const blocked = leafAt(6);
    expect(dig(coerceJsonSchemaPrimitives(blocked.schema, blocked.params)['root'], 6)).toBe('5');
    const allowed = leafAt(5);
    expect(dig(coerceJsonSchemaPrimitives(allowed.schema, allowed.params)['root'], 5)).toBe(5);
  });

  it('parses stringified JSON for declared object/array members (2026-07-24 browser.scrape incident class)', () => {
    const schema = {
      type: 'object',
      properties: {
        selectors: { type: 'object' },
        operations: { type: 'array', items: { type: 'object', properties: { width: { type: 'number' } } } },
      },
    };
    const out = coerceJsonSchemaPrimitives(schema, {
      selectors: '{"scores": ".score"}',
      operations: '[{"width": "300"}]',
    });
    expect(out['selectors']).toEqual({ scores: '.score' });
    // Nested declared primitives inside the parsed value coerce too.
    expect(out['operations']).toEqual([{ width: 300 }]);
  });

  it('leaves stringified JSON alone on shape mismatch, malformed input, or string-admitting unions', () => {
    const schema = {
      type: 'object',
      properties: {
        selectors: { type: 'object' },
        loose: { type: ['object', 'string'] },
      },
    };
    const out = coerceJsonSchemaPrimitives(schema, {
      selectors: '["array", "not", "object"]',
      loose: '{"stays": "a-string"}',
    });
    expect(out['selectors']).toBe('["array", "not", "object"]');
    expect(out['loose']).toBe('{"stays": "a-string"}');
    expect(coerceJsonSchemaPrimitives(schema, { selectors: '{"a": ' })['selectors']).toBe('{"a": ');
  });

  it('self-referential schema cannot loop past the cap', () => {
    const spec: Record<string, unknown> = { type: 'object' };
    spec['properties'] = { k: spec };
    const value: Record<string, unknown> = {};
    value['k'] = value;
    const schema = { type: 'object', properties: { root: spec } };
    // Must terminate (depth cap) and leave the cyclic value untouched.
    expect(coerceJsonSchemaPrimitives(schema, { root: value })['root']).toBe(value);
  });
});
