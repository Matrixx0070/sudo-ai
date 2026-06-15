/**
 * Tests for the LoopExitGuard pipeline — composable exit-gate chain
 * intended to replace the hand-rolled inline guard calls in loop.ts
 * one detector at a time.
 */

import { describe, it, expect } from 'vitest';
import {
  runLoopExitGuardChain,
  fromAllowWarnAbortCheck,
  type LoopExitGuardCheck,
} from '../../src/core/agent/loop-exit-guard.js';

interface Ctx {
  step: number;
}

function guard(
  name: string,
  action: 'continue' | 'warn' | 'exit',
  reason?: string,
): LoopExitGuardCheck<Ctx> {
  return { name, check: () => ({ action, reason }) };
}

describe('runLoopExitGuardChain', () => {
  it('returns continue when no guards fire', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      guard('a', 'continue'),
      guard('b', 'continue'),
    ], { step: 0 });
    expect(r.action).toBe('continue');
    expect(r.warnings).toEqual([]);
  });

  it('exits on the first exit decision and short-circuits', async () => {
    let downstreamRan = false;
    const r = await runLoopExitGuardChain<Ctx>([
      guard('a', 'continue'),
      guard('b', 'exit', 'over budget'),
      { name: 'c', check: () => { downstreamRan = true; return { action: 'continue' }; } },
    ], { step: 0 });
    expect(r.action).toBe('exit');
    expect(r.decidedBy).toBe('b');
    expect(r.reason).toBe('over budget');
    expect(downstreamRan).toBe(false);
  });

  it('collects all warns when no guard exits', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      guard('a', 'warn', 'first'),
      guard('b', 'continue'),
      guard('c', 'warn', 'second'),
    ], { step: 0 });
    expect(r.action).toBe('warn');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]!.guard).toBe('a');
    expect(r.warnings[1]!.guard).toBe('c');
    expect(r.reason).toContain('first');
    expect(r.reason).toContain('second');
  });

  it('exit takes priority even when earlier guards warned', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      guard('a', 'warn', 'careful'),
      guard('b', 'exit', 'limit hit'),
    ], { step: 0 });
    expect(r.action).toBe('exit');
    expect(r.decidedBy).toBe('b');
    // Warns collected before the exit are surfaced for the orchestrator.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.reason).toBe('careful');
  });

  it('treats a thrown guard as continue (fail-open)', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      { name: 'thrower', check: () => { throw new Error('boom'); } },
      guard('after', 'continue'),
    ], { step: 0 });
    expect(r.action).toBe('continue');
  });

  it('awaits async guards', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      { name: 'slow', check: async () => ({ action: 'exit', reason: 'deferred decision' }) },
    ], { step: 0 });
    expect(r.action).toBe('exit');
    expect(r.reason).toBe('deferred decision');
  });

  it('passes the context object through unchanged', async () => {
    let seen: Ctx | null = null;
    await runLoopExitGuardChain<Ctx>([
      { name: 'spy', check: (c) => { seen = c; return { action: 'continue' }; } },
    ], { step: 42 });
    expect(seen).toEqual({ step: 42 });
  });

  it('fills decision.guard with the producing guard name', async () => {
    const r = await runLoopExitGuardChain<Ctx>([
      guard('first', 'warn', 'A'),
      guard('second', 'warn', 'B'),
    ], { step: 0 });
    expect(r.warnings[0]!.guard).toBe('first');
    expect(r.warnings[1]!.guard).toBe('second');
  });
});

describe('fromAllowWarnAbortCheck', () => {
  it('maps allow → continue', async () => {
    const g = fromAllowWarnAbortCheck<Ctx>('legacy', () => ({ action: 'allow' }));
    const r = await runLoopExitGuardChain<Ctx>([g], { step: 0 });
    expect(r.action).toBe('continue');
  });

  it('maps warn → warn and preserves reason', async () => {
    const g = fromAllowWarnAbortCheck<Ctx>('legacy', () => ({ action: 'warn', reason: 'careful' }));
    const r = await runLoopExitGuardChain<Ctx>([g], { step: 0 });
    expect(r.action).toBe('warn');
    expect(r.warnings[0]!.reason).toBe('careful');
  });

  it('maps abort → exit and preserves reason', async () => {
    const g = fromAllowWarnAbortCheck<Ctx>('legacy', () => ({ action: 'abort', reason: 'bad' }));
    const r = await runLoopExitGuardChain<Ctx>([g], { step: 0 });
    expect(r.action).toBe('exit');
    expect(r.reason).toBe('bad');
  });

  it('supports async legacy callbacks', async () => {
    const g = fromAllowWarnAbortCheck<Ctx>('async-legacy', async () => ({ action: 'abort' }));
    const r = await runLoopExitGuardChain<Ctx>([g], { step: 0 });
    expect(r.action).toBe('exit');
  });
});
