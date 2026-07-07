/**
 * @file tests/brain/tool-schema-compat.test.ts
 * @description Tests for per-provider tool-schema normalization (the xAI
 *   400-"format" fix: strip validation keywords xAI rejects).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  stripUnsupportedSchemaKeywords,
  sanitizeToolSchemaForProvider,
  XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from '../../src/core/brain/tool-schema-compat.js';

describe('stripUnsupportedSchemaKeywords', () => {
  const KW = XAI_UNSUPPORTED_SCHEMA_KEYWORDS;

  it('drops top-level and nested constraint keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'the name' },
        tags: { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 1, maxItems: 5 },
      },
      required: ['name'],
    };
    const out = stripUnsupportedSchemaKeywords(schema, KW) as typeof schema;
    expect(out.properties.name).toEqual({ type: 'string', description: 'the name' });
    expect(out.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(out.required).toEqual(['name']); // structural keys preserved
  });

  it('recurses through anyOf/oneOf/allOf and $defs', () => {
    const schema = {
      $defs: { S: { type: 'string', minLength: 3 } },
      anyOf: [{ type: 'string', maxLength: 10 }, { type: 'number' }],
    };
    const out = stripUnsupportedSchemaKeywords(schema, KW) as any;
    expect(out.$defs.S).toEqual({ type: 'string' });
    expect(out.anyOf[0]).toEqual({ type: 'string' });
    expect(out.anyOf[1]).toEqual({ type: 'number' });
  });

  it('preserves a property literally NAMED like a keyword (data, not constraint)', () => {
    const schema = {
      type: 'object',
      properties: {
        minItems: { type: 'number', description: 'user-facing field named minItems' },
      },
      enum: ['minLength', 'maxItems'],
    };
    const out = stripUnsupportedSchemaKeywords(schema, KW) as any;
    // The PROPERTY named minItems survives; its inner constraint keywords would be stripped
    // but it has none here.
    expect(out.properties.minItems).toEqual({ type: 'number', description: 'user-facing field named minItems' });
    expect(out.enum).toEqual(['minLength', 'maxItems']); // enum values are data
  });

  it('does not mutate the input', () => {
    const schema = { type: 'string', minLength: 1 };
    const copy = JSON.parse(JSON.stringify(schema));
    stripUnsupportedSchemaKeywords(schema, KW);
    expect(schema).toEqual(copy);
  });

  it('handles primitives and null gracefully', () => {
    expect(stripUnsupportedSchemaKeywords(null, KW)).toBeNull();
    expect(stripUnsupportedSchemaKeywords('x', KW)).toBe('x');
    expect(stripUnsupportedSchemaKeywords(5, KW)).toBe(5);
  });
});

describe('sanitizeToolSchemaForProvider', () => {
  const saved = process.env['SUDO_TOOL_SCHEMA_COMPAT'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_TOOL_SCHEMA_COMPAT'];
    else process.env['SUDO_TOOL_SCHEMA_COMPAT'] = saved;
  });

  const schema = { type: 'object', properties: { q: { type: 'string', minLength: 1 } } };

  it('strips for xai/* models', () => {
    const out = sanitizeToolSchemaForProvider(schema, 'xai/grok-4-fast-non-reasoning') as any;
    expect(out.properties.q).toEqual({ type: 'string' });
  });

  it('is a pass-through for non-xai providers (Anthropic tolerates the keywords)', () => {
    const out = sanitizeToolSchemaForProvider(schema, 'claude-oauth/claude-opus-4-8');
    expect(out).toBe(schema); // same reference — untouched
  });

  it('kill-switch SUDO_TOOL_SCHEMA_COMPAT=0 disables stripping even for xai', () => {
    process.env['SUDO_TOOL_SCHEMA_COMPAT'] = '0';
    const out = sanitizeToolSchemaForProvider(schema, 'xai/grok-4-fast-non-reasoning');
    expect(out).toBe(schema);
  });
});
