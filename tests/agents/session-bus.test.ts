/**
 * Session bus hop/cycle primitives (Spec 6).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getSendChain, setSendChain, checkAndAdvance, buildEnvelope, MAX_HOP_DEPTH, __resetSessionBusForTests } from '../../src/core/agents/session-bus.js';

beforeEach(() => __resetSessionBusForTests());

describe('session-bus hop/cycle', () => {
  it('a root session starts at depth 0', () => {
    expect(getSendChain('A')).toEqual({ depth: 0, chain: ['A'] });
  });

  it('advances depth + chain on each hop', () => {
    const g1 = checkAndAdvance('A', 'B');
    expect(g1.ok).toBe(true);
    expect(g1.next).toEqual({ depth: 1, chain: ['A', 'B'] });
    setSendChain('B', g1.next!);
    const g2 = checkAndAdvance('B', 'C');
    expect(g2.next).toEqual({ depth: 2, chain: ['A', 'B', 'C'] });
  });

  it('blocks a cycle (A→B→…→A)', () => {
    setSendChain('B', { depth: 1, chain: ['A', 'B'] });
    const g = checkAndAdvance('B', 'A');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/cycle/i);
  });

  it(`blocks at hop-depth ${MAX_HOP_DEPTH}`, () => {
    setSendChain('D', { depth: MAX_HOP_DEPTH, chain: ['A', 'B', 'C', 'D'] });
    const g = checkAndAdvance('D', 'E');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/hop-depth/i);
  });

  it('sending to self is a cycle', () => {
    expect(checkAndAdvance('A', 'A').ok).toBe(false);
  });

  it('envelope labels the origin', () => {
    expect(buildEnvelope('s1', 'web', 'hi')).toContain('session:s1 channel:web');
    expect(buildEnvelope('s1', undefined, 'hi')).toContain('session:s1');
  });
});
