/**
 * @file tests/cognition/re-anchor-emitter.test.ts
 * @description Unit tests for createReAnchorEmitter helper.
 *
 * Wave 7D — covers both write paths, individual failures, combined failure,
 * and the never-throw guarantee. No DB, no FS, no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReAnchorEmitter } from '../../src/core/cognition/re-anchor-emitter.js';
import type { TrustTrackerLike, AuditDbLike } from '../../src/core/cognition/re-anchor-emitter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(): AuditDbLike & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn();
  const prepare = vi.fn().mockReturnValue({ run });
  return { prepare, run };
}

function makeMockTracker(): TrustTrackerLike & { recordOutcome: ReturnType<typeof vi.fn> } {
  return { recordOutcome: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createReAnchorEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('E-1: fires trust tracker recordOutcome with kind=re-anchor', () => {
    const tracker = makeMockTracker();
    const db = makeMockDb();
    const emit = createReAnchorEmitter('post-veto', db, tracker);

    emit();

    expect(tracker.recordOutcome).toHaveBeenCalledTimes(1);
    const call = tracker.recordOutcome.mock.calls[0]?.[0] as { kind: string; timestamp: number };
    expect(call.kind).toBe('re-anchor');
    expect(typeof call.timestamp).toBe('number');
  });

  it('E-2: fires audit_chain INSERT with correct learned text', () => {
    const tracker = makeMockTracker();
    const db = makeMockDb();
    const emit = createReAnchorEmitter('post-discordance', db, tracker);

    emit();

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
    // run args: (uuid, timestamp, learned)
    const runArgs = db.run.mock.calls[0] as unknown[];
    expect(typeof runArgs[0]).toBe('string'); // uuid
    expect(typeof runArgs[1]).toBe('number'); // timestamp
    expect(runArgs[2]).toBe('identity re-anchor post-discordance');
  });

  it('E-3: works with different trigger strings', () => {
    const tracker = makeMockTracker();
    const db = makeMockDb();
    const emit = createReAnchorEmitter('startup', db, tracker);

    emit();

    const runArgs = db.run.mock.calls[0] as unknown[];
    expect(runArgs[2]).toBe('identity re-anchor startup');
  });

  it('E-4: handles tracker undefined (skips trust write, still writes audit)', () => {
    const db = makeMockDb();
    const emit = createReAnchorEmitter('post-dispatch', db, undefined);

    expect(() => emit()).not.toThrow();
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('E-5: handles auditDb undefined (skips audit write, still writes trust)', () => {
    const tracker = makeMockTracker();
    const emit = createReAnchorEmitter('post-veto', undefined, tracker);

    expect(() => emit()).not.toThrow();
    expect(tracker.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it('E-6: handles both undefined (no-op, no throw)', () => {
    const emit = createReAnchorEmitter('startup', undefined, undefined);

    expect(() => emit()).not.toThrow();
  });

  it('E-7: trust tracker throws — audit write still happens (fail-open)', () => {
    const tracker: TrustTrackerLike = {
      recordOutcome: vi.fn().mockImplementation(() => { throw new Error('Trust DB offline'); }),
    };
    const db = makeMockDb();
    const emit = createReAnchorEmitter('post-veto', db, tracker);

    expect(() => emit()).not.toThrow();
    // Trust failed but audit should still fire
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('E-8: audit db throws — does not throw (fail-open)', () => {
    const tracker = makeMockTracker();
    const db: AuditDbLike = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockImplementation(() => { throw new Error('Audit DB offline'); }),
      }),
    };
    const emit = createReAnchorEmitter('post-veto', db, tracker);

    expect(() => emit()).not.toThrow();
    // Trust write should have fired before audit threw
    expect(tracker.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it('E-9: multiple calls emit multiple events (not idempotent by default)', () => {
    const tracker = makeMockTracker();
    const db = makeMockDb();
    const emit = createReAnchorEmitter('post-dispatch', db, tracker);

    emit();
    emit();
    emit();

    expect(tracker.recordOutcome).toHaveBeenCalledTimes(3);
    expect(db.run).toHaveBeenCalledTimes(3);
  });

  it('E-10: returned function never throws even when inner logic panics', () => {
    // Simulate catastrophic failure inside prepare
    const db: AuditDbLike = {
      prepare: vi.fn().mockImplementation(() => { throw new Error('panic'); }),
    };
    const emit = createReAnchorEmitter('startup', db, undefined);

    expect(() => emit()).not.toThrow();
  });
});
