/**
 * redactDeep — strips secret-KEYED values from an object graph while preserving
 * shape. Used at capture/publish boundaries (trace args) so downstream consumers
 * get the input's structure, never the secret in it.
 */
import { describe, it, expect } from 'vitest';
import { redactDeep } from '../../../src/core/shared/redact.js';

describe('redactDeep', () => {
  it('redacts sensitive keys, keeps the rest of the shape', () => {
    const out = redactDeep({ cmd: 'ls', apiKey: 'sk-abc123', nested: { password: 'hunter2', path: 'src/x' } }) as Record<string, unknown>;
    expect(out['cmd']).toBe('ls');
    expect(out['apiKey']).toBe('<redacted>');
    expect((out['nested'] as Record<string, unknown>)['password']).toBe('<redacted>');
    expect((out['nested'] as Record<string, unknown>)['path']).toBe('src/x');
  });
  it('walks arrays and passes primitives through', () => {
    expect(redactDeep([{ token: 't' }, 'plain', 5])).toEqual([{ token: '<redacted>' }, 'plain', 5]);
    expect(redactDeep('just a string')).toBe('just a string');
    expect(redactDeep(null)).toBeNull();
  });
  it('is cycle-safe', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a['self'] = a;
    expect(() => redactDeep(a)).not.toThrow();
  });
});
