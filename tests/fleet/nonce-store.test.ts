/**
 * @file tests/fleet/nonce-store.test.ts
 * @description Gap #28c slice 4 — in-memory nonce store unit tests.
 */

import { describe, it, expect } from 'vitest';
import { NonceStore } from '../../src/core/fleet/nonce-store.js';

describe('NonceStore', () => {
  it('NS-01: issue + consume → true (single use)', () => {
    const ns = new NonceStore();
    const { nonce } = ns.issue('d1');
    expect(ns.consume('d1', nonce)).toBe(true);
  });

  it('NS-02: replay consume → false (single-use)', () => {
    const ns = new NonceStore();
    const { nonce } = ns.issue('d1');
    ns.consume('d1', nonce);
    expect(ns.consume('d1', nonce)).toBe(false);
  });

  it('NS-03: wrong nonce → false', () => {
    const ns = new NonceStore();
    ns.issue('d1');
    expect(ns.consume('d1', 'not-the-real-nonce')).toBe(false);
  });

  it('NS-04: wrong device id → false', () => {
    const ns = new NonceStore();
    const { nonce } = ns.issue('d1');
    expect(ns.consume('d2', nonce)).toBe(false);
  });

  it('NS-05: expired nonce → false (and removed)', () => {
    let t = 1_000_000;
    const ns = new NonceStore({ ttlMs: 1000, now: () => t });
    const { nonce } = ns.issue('d1');
    t += 2000;
    expect(ns.consume('d1', nonce)).toBe(false);
    expect(ns.size()).toBe(0);
  });

  it('NS-06: re-issuing for the same device overwrites the previous nonce', () => {
    const ns = new NonceStore();
    const a = ns.issue('d1').nonce;
    const b = ns.issue('d1').nonce;
    expect(a).not.toBe(b);
    expect(ns.consume('d1', a)).toBe(false); // old nonce gone
    expect(ns.consume('d1', b)).toBe(true);
  });

  it('NS-07: independent device ids', () => {
    const ns = new NonceStore();
    const a = ns.issue('d-a').nonce;
    const b = ns.issue('d-b').nonce;
    expect(ns.consume('d-a', a)).toBe(true);
    expect(ns.consume('d-b', b)).toBe(true);
  });

  it('NS-08: sweepExpired runs opportunistically on issue', () => {
    let t = 1_000_000;
    const ns = new NonceStore({ ttlMs: 1000, now: () => t });
    ns.issue('d1');
    expect(ns.size()).toBe(1);
    t += 2000;
    // A new issue should sweep + replace.
    ns.issue('d2');
    expect(ns.size()).toBe(1); // d1 swept; d2 fresh
  });
});
