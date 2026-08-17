/**
 * @file computer-longhorizon.test.ts
 * @description Phase 2 — durable resumable runs, skill memory, viewport guard,
 * action coercion, and the argv-injection input guard. Deterministic, no display.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanRunStore, PlanRunner, type PlanRunState } from '../../src/core/tools/builtin/computer-use/core/plan-runner.js';
import { SkillStore } from '../../src/core/tools/builtin/computer-use/core/skill-store.js';
import { viewportAllowed } from '../../src/core/tools/builtin/computer-use/core/viewport.js';
import { LinuxInputSink } from '../../src/core/tools/builtin/computer-use/core/linux-input.js';
import type { ActionExecutor } from '../../src/core/tools/builtin/computer-use/core/executor.js';
import type { Action, StepResult } from '../../src/core/tools/builtin/computer-use/core/types.js';

function okStep(action: Action): StepResult {
  return { action, verdict: 'ok', recovery: [], beforeSeq: 0, afterSeq: 1, durationMs: 1, message: 'ok' };
}
function failStep(action: Action): StepResult {
  return { action, verdict: 'expectation-failed', recovery: ['reground', 'replan', 'restart-subgoal', 'escalate'], beforeSeq: 0, afterSeq: 0, durationMs: 1, message: 'nope' };
}

/** Fake executor recording which action labels it was asked to run. */
function fakeExecutor(seen: string[], failAt = -1): ActionExecutor {
  let n = 0;
  return {
    async step(_subgoal: string, action: Action) {
      seen.push(action.label ?? String(n));
      const i = n++;
      return i === failAt ? failStep(action) : okStep(action);
    },
  } as unknown as ActionExecutor;
}

const plan = (labels: string[]): Action[] => labels.map((l) => ({ kind: 'wait' as const, ms: 0, label: l }));

describe('PlanRunner durability + resume', () => {
  let dir: string;
  let store: PlanRunStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cu-runs-'));
    store = new PlanRunStore(dir);
  });

  it('persists the cursor after each step and reports done on completion', async () => {
    const seen: string[] = [];
    const runner = new PlanRunner({ store, makeExecutor: () => fakeExecutor(seen) });
    const seed: Omit<PlanRunState, 'cursor' | 'status' | 'results' | 'createdAt' | 'updatedAt'> = {
      runId: 'r1', sessionId: 's', display: ':t', subgoal: 'g', actions: plan(['a', 'b', 'c']),
    };
    const res = await runner.start(seed);
    expect(res.status).toBe('done');
    expect(res.completed).toBe(3);
    const saved = await store.load('r1');
    expect(saved?.cursor).toBe(3);
    expect(saved?.status).toBe('done');
  });

  it('resumes from the saved cursor after a simulated restart — no re-run of completed steps', async () => {
    // First run fails at index 2 (third action).
    const seen1: string[] = [];
    const r1 = new PlanRunner({ store, makeExecutor: () => fakeExecutor(seen1, 2) });
    const seed: Omit<PlanRunState, 'cursor' | 'status' | 'results' | 'createdAt' | 'updatedAt'> = {
      runId: 'r2', sessionId: 's', display: ':t', subgoal: 'g', actions: plan(['a', 'b', 'c', 'd', 'e']),
    };
    const first = await r1.start(seed);
    expect(first.status).toBe('failed');
    expect(first.completed).toBe(2); // a,b done; c failed
    expect(seen1).toEqual(['a', 'b', 'c']);

    // Simulate a fresh process: brand-new runner + executor over the SAME store.
    const seen2: string[] = [];
    const r2 = new PlanRunner({ store, makeExecutor: () => fakeExecutor(seen2) });
    const resumed = await r2.resume('r2');
    expect(resumed.status).toBe('done');
    expect(resumed.completed).toBe(5);
    // The second executor only ever saw the remaining steps c,d,e — a,b were not replayed.
    expect(seen2).toEqual(['c', 'd', 'e']);
  });
});

describe('SkillStore induce + retrieve', () => {
  let dir: string;
  let store: SkillStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cu-skills-'));
    store = new SkillStore(dir);
  });

  it('induces a skill and retrieves it for a similar subgoal', async () => {
    const actions: Action[] = [{ kind: 'key', key: 'ctrl+t', label: 'new tab' }];
    await store.induce('open a new browser tab', actions);
    const hit = await store.find('open new tab in browser');
    expect(hit).not.toBeNull();
    expect(hit!.actions).toEqual(actions);
    const miss = await store.find('format the hard drive');
    expect(miss).toBeNull();
  });

  it('tracks use/success counts', async () => {
    const s = await store.induce('do a thing', [{ kind: 'wait', ms: 0 }]);
    await store.recordUse(s.id, true);
    await store.recordUse(s.id, false);
    const reread = await store.get(s.id);
    expect(reread?.timesUsed).toBe(2);
    expect(reread?.successes).toBe(1);
  });
});

describe('viewport privacy guard', () => {
  const ENV = process.env['SUDO_COMPUTER_VIEWPORT'];
  afterEach(() => {
    if (ENV === undefined) delete process.env['SUDO_COMPUTER_VIEWPORT'];
    else process.env['SUDO_COMPUTER_VIEWPORT'] = ENV;
  });

  it('streams ONLY for owner + DM + flag on', () => {
    process.env['SUDO_COMPUTER_VIEWPORT'] = '1';
    expect(viewportAllowed({ isOwner: true, chatType: 'dm' })).toBe(true);
    expect(viewportAllowed({ isOwner: false, chatType: 'dm' })).toBe(false);
    expect(viewportAllowed({ isOwner: true, chatType: 'group' })).toBe(false);
    expect(viewportAllowed({ isOwner: true })).toBe(false);
    delete process.env['SUDO_COMPUTER_VIEWPORT'];
    expect(viewportAllowed({ isOwner: true, chatType: 'dm' })).toBe(false);
  });
});

describe('input argv-injection guard', () => {
  it('rejects a key that would smuggle an xdotool flag', async () => {
    const sink = new LinuxInputSink(':999', false); // display never touched — rejected before spawn
    const r = await sink.key('--clearmodifiers');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid key/);
  });
});
