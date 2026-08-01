/**
 * Tests for the enforced media spend caps (roadmap B6).
 *
 * Production-readiness gate 8 in audit/04-ROADMAP.md is explicit:
 *   "A hard per-video and per-day USD cap HALTS the pipeline on exhaustion —
 *    proven by a test that drives it to the cap and asserts refusal, not by
 *    reading the code."
 *
 * So the central tests here spend in a loop until the cap bites, exactly as a
 * runaway retry would, and assert the refusal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertMediaSpendAllowed,
  checkMediaSpend,
  recordMediaSpend,
  costOf,
  getJobSpend,
  clearJobSpend,
  __resetAllJobSpend,
  readMediaSpendConfig,
  MediaSpendExceededError,
  MEDIA_UNIT_COSTS,
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_JOB_CAP_USD,
  type MediaSpendConfig,
} from '../../src/core/billing/media-spend.js';
import { CostTracker } from '../../src/core/billing/cost-tracker.js';

let dir: string;
let tracker: CostTracker;

// The guard reads today's spend through getCostTracker(); point that at a
// throwaway db so tests never touch the real mind.db.
vi.mock('../../src/core/billing/cost-tracker.js', async (orig) => {
  const actual = await orig<typeof import('../../src/core/billing/cost-tracker.js')>();
  return { ...actual, getCostTracker: () => tracker };
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-spend-'));
  tracker = new CostTracker(join(dir, 'mind.db'));
  __resetAllJobSpend();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CFG = (over: Partial<MediaSpendConfig> = {}): MediaSpendConfig => ({
  dailyCapUsd: 10,
  jobCapUsd: 2,
  disabled: false,
  ...over,
});

describe('config + costing', () => {
  it('defaults the caps ON — a money guard that ships disabled is the bug being fixed', () => {
    const c = readMediaSpendConfig({} as NodeJS.ProcessEnv);
    expect(c.disabled).toBe(false);
    expect(c.dailyCapUsd).toBe(DEFAULT_DAILY_CAP_USD);
    expect(c.jobCapUsd).toBe(DEFAULT_JOB_CAP_USD);
  });

  it('honours env overrides and ignores nonsense values', () => {
    expect(readMediaSpendConfig({ SUDO_MEDIA_DAILY_CAP_USD: '3.5' } as NodeJS.ProcessEnv).dailyCapUsd).toBe(3.5);
    expect(readMediaSpendConfig({ SUDO_MEDIA_DAILY_CAP_USD: 'abc' } as NodeJS.ProcessEnv).dailyCapUsd).toBe(10);
    expect(readMediaSpendConfig({ SUDO_MEDIA_DAILY_CAP_USD: '-5' } as NodeJS.ProcessEnv).dailyCapUsd).toBe(10);
    expect(readMediaSpendConfig({ SUDO_MEDIA_CAP_DISABLE: '1' } as NodeJS.ProcessEnv).disabled).toBe(true);
  });

  it('costs from the table, scales by units, and honours an explicit override', () => {
    expect(costOf({ operation: 'luma:video' })).toBe(MEDIA_UNIT_COSTS['luma:video']);
    expect(costOf({ operation: 'openai:tts-1k-chars', units: 4 })).toBeCloseTo(0.06, 5);
    expect(costOf({ operation: 'luma:video', costUsd: 1.23 })).toBe(1.23);
    expect(costOf({ operation: 'unknown:thing' })).toBe(0);
  });
});

describe('recording — the half that did not exist before', () => {
  it('writes media spend into the cost tracker, which previously saw $0', () => {
    expect(tracker.getTodayCost().total).toBe(0);
    recordMediaSpend({ operation: 'luma:video' });
    expect(tracker.getTodayCost().total).toBeCloseTo(0.35, 5);
    expect(tracker.getTodayCost().byProvider['luma']).toBeCloseTo(0.35, 5);
  });

  it('accumulates per job and clears on demand', () => {
    recordMediaSpend({ operation: 'luma:video', jobId: 'vid-1' });
    recordMediaSpend({ operation: 'luma:video', jobId: 'vid-1' });
    recordMediaSpend({ operation: 'luma:video', jobId: 'vid-2' });
    expect(getJobSpend('vid-1')).toBeCloseTo(0.70, 5);
    expect(getJobSpend('vid-2')).toBeCloseTo(0.35, 5);
    clearJobSpend('vid-1');
    expect(getJobSpend('vid-1')).toBe(0);
  });
});

describe('GATE 8 — driving the caps to exhaustion halts the pipeline', () => {
  it('HALTS a runaway retry loop at the per-job cap', () => {
    const cfg = CFG({ jobCapUsd: 2 });
    let calls = 0;
    let halted: MediaSpendExceededError | null = null;

    // Exactly the shape of a retry storm: keep generating until something stops it.
    for (let i = 0; i < 100; i++) {
      try {
        assertMediaSpendAllowed({ operation: 'luma:video', jobId: 'vid-1' }, cfg);
      } catch (err) {
        halted = err as MediaSpendExceededError;
        break;
      }
      recordMediaSpend({ operation: 'luma:video', jobId: 'vid-1' });
      calls++;
    }

    expect(halted, 'the loop must be stopped, not run 100 times').toBeInstanceOf(MediaSpendExceededError);
    expect(halted!.scope).toBe('job');
    expect(calls).toBe(5);                       // 5 x $0.35 = $1.75; a 6th would exceed $2
    expect(getJobSpend('vid-1')).toBeCloseTo(1.75, 5);
    expect(getJobSpend('vid-1')).toBeLessThanOrEqual(cfg.jobCapUsd);
  });

  it('HALTS at the daily cap across separate jobs', () => {
    const cfg = CFG({ dailyCapUsd: 1, jobCapUsd: 100 });
    let calls = 0;
    let halted: MediaSpendExceededError | null = null;

    for (let i = 0; i < 100; i++) {
      try {
        assertMediaSpendAllowed({ operation: 'luma:video', jobId: `vid-${i}` }, cfg);
      } catch (err) {
        halted = err as MediaSpendExceededError;
        break;
      }
      recordMediaSpend({ operation: 'luma:video', jobId: `vid-${i}` });
      calls++;
    }

    expect(halted).toBeInstanceOf(MediaSpendExceededError);
    expect(halted!.scope).toBe('daily');
    expect(calls).toBe(2);                       // 2 x $0.35 = $0.70; a 3rd would exceed $1
    expect(tracker.getTodayCost().total).toBeLessThanOrEqual(cfg.dailyCapUsd);
  });

  it('refuses a single call that alone would blow the cap — before spending it', () => {
    const cfg = CFG({ dailyCapUsd: 1, jobCapUsd: 100 });
    expect(() => assertMediaSpendAllowed({ operation: 'luma:video', costUsd: 5 }, cfg))
      .toThrow(MediaSpendExceededError);
    expect(tracker.getTodayCost().total, 'nothing may be spent on a refused call').toBe(0);
  });

  it('lets spend right up to the cap through', () => {
    const cfg = CFG({ dailyCapUsd: 1, jobCapUsd: 100 });
    expect(() => assertMediaSpendAllowed({ operation: 'luma:video', costUsd: 1 }, cfg)).not.toThrow();
    expect(() => assertMediaSpendAllowed({ operation: 'luma:video', costUsd: 1.01 }, cfg)).toThrow();
  });
});

describe('failure modes', () => {
  it('refuses when spend cannot be read — never assumes $0', () => {
    const broken = { getTodayCost: () => { throw new Error('db locked'); } } as unknown as CostTracker;
    const saved = tracker;
    tracker = broken;
    const check = checkMediaSpend({ operation: 'luma:video' }, CFG());
    tracker = saved;
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/refusing rather than assuming/i);
  });

  it('allows everything only when explicitly disabled', () => {
    const cfg = CFG({ dailyCapUsd: 0, disabled: true });
    const check = checkMediaSpend({ operation: 'luma:video', costUsd: 999 }, cfg);
    expect(check.allowed).toBe(true);
    expect(check.reason).toMatch(/DISABLED/);
  });

  it('reports both scopes in the check for observability', () => {
    recordMediaSpend({ operation: 'luma:video', jobId: 'v' });
    const c = checkMediaSpend({ operation: 'luma:video', jobId: 'v' }, CFG());
    expect(c.dailyUsd).toBeCloseTo(0.35, 5);
    expect(c.jobUsd).toBeCloseTo(0.35, 5);
    expect(c.dailyCapUsd).toBe(10);
    expect(c.jobCapUsd).toBe(2);
  });
});
