/**
 * @file tests/agent/tool-output-clamp.test.ts
 * @description Central tool-output size cap: a single un-truncated tool result
 * (large scrape/MCP/file read) must not dump its full payload into model
 * context. Verifies head+tail preservation, the marker, the env budget, and the
 * '0' kill-switch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clampToolOutput, maxToolResultChars } from '../../src/core/agent/tool-output-clamp.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env['SUDO_MAX_TOOL_RESULT_CHARS']; delete process.env['SUDO_MAX_TOOL_RESULT_CHARS']; });
afterEach(() => { if (saved === undefined) delete process.env['SUDO_MAX_TOOL_RESULT_CHARS']; else process.env['SUDO_MAX_TOOL_RESULT_CHARS'] = saved; });

describe('clampToolOutput', () => {
  it('CLMP-1: leaves output under budget unchanged', () => {
    const s = 'small output';
    expect(clampToolOutput(s, 1000)).toBe(s);
  });

  it('CLMP-2: clamps over-budget output, preserving head and tail with a marker', () => {
    const big = 'H'.repeat(800) + 'T'.repeat(800); // 1600 chars
    const out = clampToolOutput(big, 1000);
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith('H')).toBe(true);   // head preserved
    expect(out.endsWith('T')).toBe(true);     // tail preserved
    expect(out).toContain('clamped');
    expect(out).toContain('of 1600 chars omitted');
  });

  it('CLMP-3: head gets ~80% of the budget, tail the rest', () => {
    const big = 'A'.repeat(2000);
    const out = clampToolOutput(big, 100); // head 80, tail 20
    // 80 head A's + marker + 20 tail A's — count is approximate but bounded.
    expect(out).toContain('1900 of 2000 chars omitted'); // 2000 - 100 omitted
  });

  it('CLMP-4: max<=0 disables clamping (kill-switch)', () => {
    const big = 'X'.repeat(5000);
    expect(clampToolOutput(big, 0)).toBe(big);
  });

  it('CLMP-5: non-string input is returned unchanged', () => {
    // @ts-expect-error — defensive: callers may pass a non-string
    expect(clampToolOutput(undefined, 10)).toBeUndefined();
  });
});

describe('maxToolResultChars', () => {
  it('MAX-1: defaults to a generous budget when unset', () => {
    expect(maxToolResultChars()).toBe(24000);
  });
  it('MAX-2: honors a positive override', () => {
    process.env['SUDO_MAX_TOOL_RESULT_CHARS'] = '5000';
    expect(maxToolResultChars()).toBe(5000);
  });
  it('MAX-3: "0" is the kill-switch (disabled)', () => {
    process.env['SUDO_MAX_TOOL_RESULT_CHARS'] = '0';
    expect(maxToolResultChars()).toBe(0);
  });
  it('MAX-4: a garbage value falls back to the default', () => {
    process.env['SUDO_MAX_TOOL_RESULT_CHARS'] = 'lots';
    expect(maxToolResultChars()).toBe(24000);
  });
});
