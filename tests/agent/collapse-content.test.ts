/**
 * Tests for collapseContent — the agent's "Layer 4" tool-result context
 * compaction. Reading source whole is a first-class need (self-edit/review),
 * so file reads keep far more (MAX_READ=16000) than other tool output
 * (MAX=3000) before paging. meta.self-modify is the self-edit reader, so it
 * must be treated as a read tool — previously it fell through to the blunt
 * "chars truncated" default, which gutted a ~200-line module the agent was
 * trying to read whole and drove a re-read loop.
 */

import { describe, it, expect } from 'vitest';
import { collapseContent } from '../../src/core/agent/loop-helpers.js';

const big = (chars: number, fill = 'x') => fill.repeat(chars);

describe('collapseContent — read tools keep whole modules', () => {
  it('returns a ~200-line module (under MAX_READ) intact for coder.read-file', () => {
    const file = big(7600); // ~198 lines of source, over the 3000 generic cap
    const out = collapseContent(file, 'coder.read-file');
    expect(out).toBe(file);
    expect(out).not.toContain('truncated');
    expect(out).not.toContain('collapsed');
  });

  it('treats meta.self-modify as a read tool (no blunt "chars truncated")', () => {
    const file = big(7600);
    const out = collapseContent(file, 'meta.self-modify');
    expect(out).toBe(file);
    expect(out).not.toContain('chars truncated');
  });

  it('pages a read only beyond MAX_READ, pointing at offset/limit', () => {
    const huge = big(20000);
    const out = collapseContent(huge, 'meta.self-modify');
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('offset/limit');
    expect(out).not.toContain('chars truncated'); // friendly read message, not the default
  });
});

describe('collapseContent — non-read output stays lean at MAX', () => {
  it('hard-caps unrecognized large tool output at 3000 with "chars truncated"', () => {
    const blob = big(9000);
    const out = collapseContent(blob, 'system.exec');
    expect(out).toContain('chars truncated');
    expect(out.length).toBeLessThan(3200); // ~3000 + marker
  });

  it('returns short content unchanged regardless of tool', () => {
    const small = big(500);
    expect(collapseContent(small, 'system.exec')).toBe(small);
    expect(collapseContent(small, 'meta.self-modify')).toBe(small);
  });
});
