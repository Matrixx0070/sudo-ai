/**
 * @file tool-name-collision.test.ts
 * @description Tests for duplicate-tool-name detection and once-per-signature warning.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  findDuplicateToolNames,
  warnOnDuplicateToolNames,
  resetDuplicateToolNameWarnings,
} from '../../src/core/brain/tool-name-collision.js';

beforeEach(() => {
  warnSpy.mockClear();
  resetDuplicateToolNameWarnings();
});

describe('findDuplicateToolNames', () => {
  it('returns [] for empty, single, and all-unique entries', () => {
    expect(findDuplicateToolNames([])).toEqual([]);
    expect(findDuplicateToolNames([['a', {}]])).toEqual([]);
    expect(findDuplicateToolNames([['a', {}], ['b', {}], ['c', {}]])).toEqual([]);
  });

  it('reports each duplicated name with its count, in first-seen order', () => {
    const entries: Array<[string, unknown]> = [
      ['shell.exec', {}],
      ['fs.read', {}],
      ['shell.exec', {}],
      ['fs.read', {}],
      ['fs.read', {}],
      ['browser.click', {}],
    ];
    expect(findDuplicateToolNames(entries)).toEqual([
      { name: 'shell.exec', count: 2 },
      { name: 'fs.read', count: 3 },
    ]);
  });
});

describe('warnOnDuplicateToolNames', () => {
  it('does not warn when there are no duplicates', () => {
    warnOnDuplicateToolNames([['a', {}], ['b', {}]]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns with the duplicate details on collision', () => {
    warnOnDuplicateToolNames([['a', {}], ['a', {}], ['b', {}]]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      { duplicates: [{ name: 'a', count: 2 }], totalTools: 3 },
      expect.stringContaining('LAST definition'),
    );
  });

  it('warns only once per identical collision signature', () => {
    const entries: Array<[string, unknown]> = [['a', {}], ['a', {}]];
    warnOnDuplicateToolNames(entries);
    warnOnDuplicateToolNames(entries);
    warnOnDuplicateToolNames([['a', {}], ['a', {}], ['x', {}]]); // same signature a:2
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns again for a different collision signature', () => {
    warnOnDuplicateToolNames([['a', {}], ['a', {}]]);
    warnOnDuplicateToolNames([['a', {}], ['a', {}], ['a', {}]]); // a:3 ≠ a:2
    warnOnDuplicateToolNames([['b', {}], ['b', {}]]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('reset hook clears the once-per-signature memory', () => {
    warnOnDuplicateToolNames([['a', {}], ['a', {}]]);
    resetDuplicateToolNameWarnings();
    warnOnDuplicateToolNames([['a', {}], ['a', {}]]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('never throws and does not mutate entries', () => {
    const entries: Array<[string, unknown]> = [['a', { keep: true }], ['a', {}]];
    expect(() => warnOnDuplicateToolNames(entries)).not.toThrow();
    expect(entries[0]![1]).toEqual({ keep: true });
    expect(entries).toHaveLength(2);
  });
});
