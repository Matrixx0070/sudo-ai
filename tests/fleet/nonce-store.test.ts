/**
 * @file tests/fleet/nonce-store.test.ts
 * @description Gap #28c slice 4 — nonce store unit tests. Slice-4-follow-up
 * adds NS-09..NS-11: SQLite-backed persistence, cross-instance consume,
 * and shut-down idempotency. Cross-instance HTTP coverage lives in
 * tests/fleet/fleet-pending-admission.test.ts (FA-10..FA-12).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  // Slice-4 follow-up — SQLite-backed nonces. The legacy in-memory mode
  // (no dbPath) stays as `:memory:` for tests; the on-disk mode lets two
  // processes share state.
  it('NS-09: persistence — nonce survives close + reopen at the same dbPath', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sudo-nonce-persist-'));
    try {
      const dbPath = path.join(tmp, 'nonce.db');
      const a = new NonceStore({ dbPath });
      const { nonce } = a.issue('dev-persist');
      a.close();
      const b = new NonceStore({ dbPath });
      try {
        expect(b.consume('dev-persist', nonce)).toBe(true);
      } finally {
        b.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('NS-10: cross-instance — issue on A, consume on B (load-balancer parity)', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sudo-nonce-multi-'));
    try {
      const dbPath = path.join(tmp, 'nonce.db');
      const a = new NonceStore({ dbPath });
      const b = new NonceStore({ dbPath });
      try {
        const { nonce } = a.issue('dev-cross');
        expect(b.consume('dev-cross', nonce)).toBe(true);
        // Replay on the issuing instance is also rejected.
        expect(a.consume('dev-cross', nonce)).toBe(false);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('NS-11: close() is idempotent (safe to call multiple times)', () => {
    const ns = new NonceStore();
    ns.close();
    expect(() => ns.close()).not.toThrow();
  });
});
