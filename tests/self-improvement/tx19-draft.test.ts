/**
 * @file tx19-draft.test.ts
 * @description The content-grounded drafter's pure parsers: file pick from the
 * candidate list, and the stage-2 patch-body parse (which rejects declines and
 * malformed bodies). The two-stage draft itself (real brain + dry-run tsc) is
 * covered by the live proof.
 */

import { describe, it, expect } from 'vitest';
import { parsePick, parsePatchBody, boundContent } from '../../src/core/self-improvement/tx19-draft.js';

describe('parsePick — choose a real candidate', () => {
  const cands = ['src/core/a.ts', 'src/core/agent/loop-guard.ts', 'src/core/agent/loop.ts'];

  it('PICK-1: returns the candidate named in the reply', () => {
    expect(parsePick('I would improve src/core/agent/loop-guard.ts for clarity.', cands)).toBe('src/core/agent/loop-guard.ts');
  });
  it('PICK-2: prefers the longest match (no prefix shadowing)', () => {
    // both loop.ts and loop-guard.ts share a stem; the full path must win.
    expect(parsePick('pick: src/core/agent/loop-guard.ts', cands)).toBe('src/core/agent/loop-guard.ts');
  });
  it('PICK-3: null when the reply names nothing in the list', () => {
    expect(parsePick('src/core/nope.ts', cands)).toBeNull();
    expect(parsePick('', cands)).toBeNull();
  });
});

describe('parsePatchBody — stage-2 verbatim patch', () => {
  it('BODY-1: parses a valid body (even fenced)', () => {
    const b = parsePatchBody('```json\n{"oldText":"a = 0;","newText":"a = 1;","rationale":"why"}\n```');
    expect(b).toEqual({ oldText: 'a = 0;', newText: 'a = 1;', rationale: 'why' });
  });
  it('BODY-2: rejects the decline sentinel and no-ops', () => {
    expect(parsePatchBody('{"oldText":""}')).toBeNull();
    expect(parsePatchBody('{"oldText":"x","newText":"x"}')).toBeNull();
  });
  it('BODY-3: rejects missing fields, oversized text, non-JSON', () => {
    expect(parsePatchBody('{"newText":"y"}')).toBeNull();
    expect(parsePatchBody(JSON.stringify({ oldText: 'a'.repeat(5000), newText: 'y' }))).toBeNull();
    expect(parsePatchBody('no json here')).toBeNull();
  });
  it('BODY-4: defaults a missing rationale to empty', () => {
    expect(parsePatchBody('{"oldText":"x","newText":"y"}')?.rationale).toBe('');
  });
});

describe('boundContent', () => {
  it('BOUND-1: passes short content through unchanged', () => {
    expect(boundContent('short file')).toBe('short file');
  });
  it('BOUND-2: truncates very large content with a marker', () => {
    const big = 'x'.repeat(25_000);
    const out = boundContent(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
  });
});
