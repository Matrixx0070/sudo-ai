/**
 * @file tests/agent/content-hash.test.ts
 * @description B5.3 — content-hash helper extracted verbatim from loop.ts into
 * its own module. These assertions pin the behavior (32-char hex, deterministic,
 * tool+args sensitive) so the pure move is provably behavior-preserving.
 */

import { describe, it, expect } from 'vitest';
import { computeContentHash } from '../../src/core/agent/content-hash.js';

describe('computeContentHash', () => {
  it('returns a 32-char lowercase hex digest', () => {
    const h = computeContentHash('Read', { file_path: '/tmp/x' });
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for the same tool + args', () => {
    const a = computeContentHash('Bash', { command: 'ls -la' });
    const b = computeContentHash('Bash', { command: 'ls -la' });
    expect(a).toBe(b);
  });

  it('differs when the tool name differs', () => {
    expect(computeContentHash('Read', { p: 1 })).not.toBe(computeContentHash('Write', { p: 1 }));
  });

  it('differs when the args differ', () => {
    expect(computeContentHash('Bash', { command: 'ls' })).not.toBe(
      computeContentHash('Bash', { command: 'rm -rf /' }),
    );
  });
});
