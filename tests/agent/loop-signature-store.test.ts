/**
 * Tests for LoopSignatureStore + LoopGuard fast-suppress integration.
 *
 * The bot's fix #5: persist loop signatures so LoopGuard short-circuits
 * the in-turn thresholds the moment a known-bad signature reappears.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  LoopSignatureStore,
  DEFAULT_SUPPRESS_HITS,
  repeatSignature,
  pingPongSignature,
  setGlobalLoopSignatureStore,
  getGlobalLoopSignatureStore,
  __resetGlobalLoopSignatureStoreForTests,
} from '../../src/core/agent/loop-signature-store.js';
import {
  LoopGuard,
  REPEAT_EXEMPT_TOOLS,
  REPEAT_ABORT_THRESHOLD,
} from '../../src/core/agent/loop-guard.js';

let db: Database.Database;
let store: LoopSignatureStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = new LoopSignatureStore(db);
});

afterEach(() => {
  __resetGlobalLoopSignatureStoreForTests();
  db.close();
});

describe('repeatSignature / pingPongSignature', () => {
  it('repeat signature is stable on inputs', () => {
    expect(repeatSignature('coder.read', 'h1')).toBe('repeat:coder.read#h1');
  });
  it('ping-pong signature is order-independent', () => {
    const sigA = pingPongSignature('a', 'h1', 'b', 'h2');
    const sigB = pingPongSignature('b', 'h2', 'a', 'h1');
    expect(sigA).toBe(sigB);
  });
});

describe('LoopSignatureStore — CRUD', () => {
  it('count() is 0 on a fresh store', () => {
    expect(store.count()).toBe(0);
  });

  it('record() inserts on first sight, increments on repeat', () => {
    expect(store.record('s1')).toBe(1);
    expect(store.record('s1')).toBe(2);
    expect(store.record('s1')).toBe(3);
    expect(store.count()).toBe(1);
    expect(store.getHits('s1')).toBe(3);
  });

  it('record() with empty string is a no-op', () => {
    expect(store.record('')).toBe(0);
    expect(store.count()).toBe(0);
  });

  it('shouldSuppress() respects the default threshold', () => {
    store.record('s1'); // 1 hit
    expect(store.shouldSuppress('s1', DEFAULT_SUPPRESS_HITS)).toBe(false);
    store.record('s1'); // 2 hits
    expect(store.shouldSuppress('s1', DEFAULT_SUPPRESS_HITS)).toBe(true);
  });

  it('shouldSuppress() respects a custom threshold', () => {
    store.record('s1');
    store.record('s1');
    expect(store.shouldSuppress('s1', 5)).toBe(false);
    expect(store.shouldSuppress('s1', 1)).toBe(true);
  });

  it('prune() drops entries older than the cutoff', () => {
    // Manually backdate via UPDATE.
    store.record('old');
    store.record('fresh');
    db.prepare("UPDATE loop_signatures SET last_seen = '1999-01-01T00:00:00.000Z' WHERE signature = 'old'").run();
    const pruned = store.prune(30);
    expect(pruned).toBe(1);
    expect(store.getHits('old')).toBe(0);
    expect(store.getHits('fresh')).toBeGreaterThan(0);
  });
});

describe('module-level singleton', () => {
  it('starts empty', () => {
    expect(getGlobalLoopSignatureStore()).toBeNull();
  });
  it('round-trips through the setter', () => {
    setGlobalLoopSignatureStore(store);
    expect(getGlobalLoopSignatureStore()).toBe(store);
  });
  it('test-reset helper clears the global without touching the DB', () => {
    setGlobalLoopSignatureStore(store);
    __resetGlobalLoopSignatureStoreForTests();
    expect(getGlobalLoopSignatureStore()).toBeNull();
    // DB still queryable.
    expect(store.count()).toBe(0);
  });
});

describe('LoopGuard — fast-suppress via persisted signatures', () => {
  it('aborts on first call when the repeat signature has crossed the suppress threshold', () => {
    const guard = new LoopGuard(store);
    // Manually seed the store at 2 hits (the default suppress threshold).
    const argsHash = (guard as unknown as { _hashArgs(a: Record<string, unknown>): string })._hashArgs({ foo: 1 });
    store.record(repeatSignature('coder.read', argsHash));
    store.record(repeatSignature('coder.read', argsHash));

    const result = guard.recordCall('coder.read', { foo: 1 });
    expect(result.action).toBe('abort');
    expect(result.reason).toMatch(/known across sessions/);
  });

  it('does NOT abort early when the suppress threshold is not yet crossed', () => {
    const guard = new LoopGuard(store);
    const argsHash = (guard as unknown as { _hashArgs(a: Record<string, unknown>): string })._hashArgs({ foo: 1 });
    store.record(repeatSignature('coder.read', argsHash)); // 1 hit — below threshold

    expect(guard.recordCall('coder.read', { foo: 1 }).action).toBe('allow');
  });

  it('persists the signature on a normal in-turn abort so future sessions fast-suppress', () => {
    const guard = new LoopGuard(store);
    // Fire enough identical calls to hit the in-turn REPEAT_ABORT_THRESHOLD.
    for (let i = 0; i < REPEAT_ABORT_THRESHOLD - 1; i++) {
      expect(guard.recordCall('coder.read', { id: 1 }).action).not.toBe('abort');
    }
    const aborted = guard.recordCall('coder.read', { id: 1 });
    expect(aborted.action).toBe('abort');
    const argsHash = (guard as unknown as { _hashArgs(a: Record<string, unknown>): string })._hashArgs({ id: 1 });
    expect(store.getHits(repeatSignature('coder.read', argsHash))).toBeGreaterThan(0);
  });

  it('falls back to the global singleton when no instance store was passed', () => {
    setGlobalLoopSignatureStore(store);
    const guard = new LoopGuard();
    const argsHash = (guard as unknown as { _hashArgs(a: Record<string, unknown>): string })._hashArgs({ foo: 1 });
    store.record(repeatSignature('coder.read', argsHash));
    store.record(repeatSignature('coder.read', argsHash));
    expect(guard.recordCall('coder.read', { foo: 1 }).action).toBe('abort');
  });

  it('exempt tools never fast-suppress even with a primed signature', () => {
    const exemptName = [...REPEAT_EXEMPT_TOOLS][0]!;
    const guard = new LoopGuard(store);
    const argsHash = (guard as unknown as { _hashArgs(a: Record<string, unknown>): string })._hashArgs({});
    store.record(repeatSignature(exemptName, argsHash));
    store.record(repeatSignature(exemptName, argsHash));
    expect(guard.recordCall(exemptName, {}).action).toBe('allow');
  });

  it('legacy zero-arg LoopGuard with no store behaves byte-identically (no abort on first call)', () => {
    const guard = new LoopGuard(); // no store, no global
    expect(guard.recordCall('coder.read', { foo: 1 }).action).toBe('allow');
  });
});
