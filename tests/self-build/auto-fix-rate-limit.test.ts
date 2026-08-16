/**
 * @file auto-fix-rate-limit.test.ts
 * @description AL8.0 R4 — the autofix hourly rate limiter fails CLOSED: an
 * autonomous PR-opening path with an unverifiable limiter must block, not
 * admit. Pins both repaired branches (no DB / query failure) plus the normal
 * under-limit and at-limit paths. White-box on the private method — the
 * public path needs the full GitHub polling harness, and the boundary itself
 * is what AL8.5 demands be test-pinned.
 */

import { describe, it, expect, vi } from 'vitest';
// Fail-closed guard: nothing in this file may reach the real gh CLI or git
// (the unmocked escape poisoned full-suite runs on 2026-08-16).
vi.mock('child_process', () => ({
  exec: (_cmd: string, cb: (e: Error | null) => void) =>
    cb(new Error('gh: command not found (mocked test env)')),
}));

import { AutoFixTrigger } from '../../src/core/self-build/auto-fix-trigger.js';

type PrivateLimiter = { _canProceedThisHour(): boolean };

function makeTrigger(mindDb: unknown): PrivateLimiter {
  const errorMemory = { suggestFix: () => null } as never;
  const metricsCollector = { record: () => undefined } as never;
  return new AutoFixTrigger(
    { errorMemory, metricsCollector, mindDb: mindDb as never },
    60_000,
  ) as unknown as PrivateLimiter;
}

function stubDb(countOrThrow: number | Error) {
  return {
    prepare: () => ({
      get: () => {
        if (countOrThrow instanceof Error) throw countOrThrow;
        return { count: countOrThrow };
      },
      run: () => undefined,
      all: () => [],
    }),
    exec: () => undefined,
  };
}

describe('AL8.0 R4 — autofix rate limit fails closed', () => {
  it('no mind.db → BLOCKED (was fail-open)', () => {
    expect(makeTrigger(undefined)._canProceedThisHour()).toBe(false);
  });

  it('rate-log query failure → BLOCKED (was fail-open)', () => {
    expect(makeTrigger(stubDb(new Error('disk I/O error')))._canProceedThisHour()).toBe(false);
  });

  it('under the hourly limit → allowed; at the limit → blocked', () => {
    expect(makeTrigger(stubDb(0))._canProceedThisHour()).toBe(true);
    expect(makeTrigger(stubDb(999))._canProceedThisHour()).toBe(false);
  });
});
