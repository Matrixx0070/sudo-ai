/**
 * Unit tests for `coerceToolSchemas` — the boundary-cast replacement that
 * landed alongside the audit-LOW sweep (PR follow-up to #204). The HTTP edge
 * types `body.tools` as `unknown[]`, so the prior `as ToolSchema[]` cast was
 * unchecked: a malformed entry would crash the Brain call rather than be
 * dropped. The coercer filters to OpenAI function-tool shape and returns
 * undefined when zero entries survive.
 */

import { describe, it, expect } from 'vitest';
import { coerceToolSchemas } from '../../src/core/api/handlers.js';

const valid = {
  type: 'function',
  function: {
    name: 'sample',
    description: 'desc',
    parameters: { type: 'object', properties: {} },
  },
};

describe('coerceToolSchemas', () => {
  it('returns undefined for undefined / non-array input', () => {
    expect(coerceToolSchemas(undefined)).toBeUndefined();
    expect(coerceToolSchemas(null)).toBeUndefined();
    expect(coerceToolSchemas('string')).toBeUndefined();
    expect(coerceToolSchemas({})).toBeUndefined();
  });

  it('passes through a fully-shaped tool entry', () => {
    const out = coerceToolSchemas([valid]);
    expect(out).toHaveLength(1);
    expect(out![0]!.function.name).toBe('sample');
  });

  it('drops entries missing type=function', () => {
    expect(coerceToolSchemas([{ ...valid, type: 'other' }])).toBeUndefined();
  });

  it('drops entries missing function.name', () => {
    expect(coerceToolSchemas([{ type: 'function', function: { description: 'd', parameters: {} } }])).toBeUndefined();
  });

  it('drops entries with empty function.name', () => {
    expect(coerceToolSchemas([{ type: 'function', function: { name: '', description: 'd', parameters: {} } }])).toBeUndefined();
  });

  it('drops entries with non-object parameters', () => {
    expect(coerceToolSchemas([{ type: 'function', function: { name: 'x', description: 'd', parameters: 'no' } }])).toBeUndefined();
  });

  it('drops entries missing function.description (verifier MED-1)', () => {
    expect(coerceToolSchemas([{ type: 'function', function: { name: 'x', parameters: {} } }])).toBeUndefined();
  });

  it('drops entries with non-string function.description', () => {
    expect(coerceToolSchemas([{ type: 'function', function: { name: 'x', description: 123, parameters: {} } }])).toBeUndefined();
  });

  it('mixes valid + invalid entries, keeping only the valid', () => {
    const out = coerceToolSchemas([
      valid,
      { type: 'function', function: { name: '' } }, // dropped: empty name
      null,                                          // dropped: not an object
      { type: 'function', function: { name: 'two', description: 'd', parameters: {} } },
    ]);
    expect(out).toHaveLength(2);
    expect(out!.map((t) => t.function.name)).toEqual(['sample', 'two']);
  });

  it('returns undefined when every entry is malformed (collapses to "no tools to forward")', () => {
    expect(coerceToolSchemas(['string', null, { type: 'function' }])).toBeUndefined();
  });
});
