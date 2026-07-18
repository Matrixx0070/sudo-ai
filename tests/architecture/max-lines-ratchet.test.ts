/**
 * GW-12: unit test for the max-lines ratchet core — proves it fails on a
 * planted oversize file and auto-tightens on shrink.
 */
import { describe, it, expect } from 'vitest';
import { ratchet } from '../../scripts/check-max-lines.js';

describe('GW-12 max-lines ratchet', () => {
  it('flags a file grown past baseline+10%', () => {
    const { violations } = ratchet({ 'a.ts': 561 }, { 'a.ts': 500 }); // limit 550
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe('a.ts');
  });
  it('allows growth within tolerance', () => {
    const { violations } = ratchet({ 'a.ts': 549 }, { 'a.ts': 500 });
    expect(violations).toEqual([]);
  });
  it('auto-tightens the baseline when a file shrinks', () => {
    const { nextBaseline } = ratchet({ 'a.ts': 420 }, { 'a.ts': 500 });
    expect(nextBaseline['a.ts']).toBe(420);
  });
  it('seeds a new large file at its current size', () => {
    const { nextBaseline, violations } = ratchet({ 'new.ts': 700 }, {}, 400);
    expect(violations).toEqual([]);
    expect(nextBaseline['new.ts']).toBe(700);
  });
  it('does not track a new small file', () => {
    const { nextBaseline } = ratchet({ 'tiny.ts': 50 }, {}, 400);
    expect(nextBaseline['tiny.ts']).toBeUndefined();
  });
});
