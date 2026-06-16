/**
 * @file cascade.test.ts
 * @description Tests for the per-attempt model cascade.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCascade,
  modelForAttempt,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/cascade.js';

const DEFAULT = 'claude-oauth/claude-sonnet-4-6';

describe('parseCascade', () => {
  it('prefers tool param `models` over everything', () => {
    const out = parseCascade({
      models: ['a', 'b'],
      model: 'c',
      envCascade: 'd,e',
      envModel: 'f',
      defaultModel: DEFAULT,
    });
    expect(out).toEqual(['a', 'b']);
  });

  it('falls back to env cascade when `models` is missing', () => {
    expect(parseCascade({ envCascade: 'a, b , c', defaultModel: DEFAULT })).toEqual(['a', 'b', 'c']);
  });

  it('falls back to single tool param `model`', () => {
    expect(parseCascade({ model: 'solo', defaultModel: DEFAULT })).toEqual(['solo']);
  });

  it('falls back to env single model when nothing else', () => {
    expect(parseCascade({ envModel: 'env-model', defaultModel: DEFAULT })).toEqual(['env-model']);
  });

  it('falls back to defaultModel with no inputs', () => {
    expect(parseCascade({ defaultModel: DEFAULT })).toEqual([DEFAULT]);
  });

  it('drops empty strings and non-strings from `models`', () => {
    const out = parseCascade({
      models: ['a', '', '  ', 42, null, 'b'] as unknown[],
      defaultModel: DEFAULT,
    });
    expect(out).toEqual(['a', 'b']);
  });

  it('dedupes preserving first occurrence', () => {
    expect(parseCascade({ models: ['a', 'b', 'a', 'c', 'b'], defaultModel: DEFAULT })).toEqual([
      'a', 'b', 'c',
    ]);
  });

  it('falls through to next source when `models` is an empty array', () => {
    expect(
      parseCascade({ models: [], envCascade: 'x,y', defaultModel: DEFAULT }),
    ).toEqual(['x', 'y']);
  });

  it('falls through to next source when envCascade is whitespace only', () => {
    expect(parseCascade({ envCascade: '   ', model: 'fallback', defaultModel: DEFAULT })).toEqual([
      'fallback',
    ]);
  });

  it('handles env cascade with trailing comma without producing empty entries', () => {
    expect(parseCascade({ envCascade: 'a,b,', defaultModel: DEFAULT })).toEqual(['a', 'b']);
  });
});

describe('modelForAttempt', () => {
  it('returns the matching index 1-based', () => {
    const c = ['a', 'b', 'c'];
    expect(modelForAttempt(c, 1)).toBe('a');
    expect(modelForAttempt(c, 2)).toBe('b');
    expect(modelForAttempt(c, 3)).toBe('c');
  });

  it('sticks with the last model when attemptIndex exceeds length', () => {
    expect(modelForAttempt(['a', 'b'], 5)).toBe('b');
    expect(modelForAttempt(['solo'], 10)).toBe('solo');
  });

  it('clamps below 1 to the first entry', () => {
    expect(modelForAttempt(['a', 'b'], 0)).toBe('a');
    expect(modelForAttempt(['a', 'b'], -3)).toBe('a');
  });

  it('throws on empty cascade (caller bug — not a real runtime path)', () => {
    expect(() => modelForAttempt([], 1)).toThrow(/at least one model/);
  });
});
