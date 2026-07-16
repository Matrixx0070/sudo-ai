/**
 * @file tests/gateway/rpc-event-seq.test.ts
 * @description Event sequencer (OpenClaw I3/I66 ordering-contract future-proof).
 */
import { describe, it, expect } from 'vitest';
import { createEventSequencer } from '../../src/core/gateway/rpc-schema.js';

describe('createEventSequencer', () => {
  it('ES-1: stamps a 1-based monotonic seq', () => {
    const s = createEventSequencer();
    expect(s.current).toBe(0);
    const a = s.next('session:update', { id: 'x' });
    const b = s.next('session:update', { id: 'y' });
    expect(a).toEqual({ type: 'event', event: 'session:update', data: { id: 'x' }, seq: 1 });
    expect(b.seq).toBe(2);
    expect(s.current).toBe(2);
  });

  it('ES-2: includes stateVersion only when provided', () => {
    const s = createEventSequencer();
    expect('stateVersion' in s.next('e', {})).toBe(false);
    const withVer = s.next('e', {}, 7);
    expect(withVer.stateVersion).toBe(7);
    expect(withVer.seq).toBe(2);
  });

  it('ES-3: each sequencer is independent (per-connection)', () => {
    const a = createEventSequencer();
    const b = createEventSequencer();
    a.next('e', {}); a.next('e', {});
    expect(b.next('e', {}).seq).toBe(1); // b unaffected by a
  });
});
