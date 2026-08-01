/**
 * @file media-spend.ts
 * @description Hard, enforced spend caps for the paid media APIs (roadmap B6).
 *
 * Closes the money hole the audit called the single fastest way to lose real
 * cash in this system. Two independent defects, both real:
 *
 *  1. **Nothing was recorded.** `media.video-generate` (Luma/Runway/Kling),
 *     `media.shorts-factory` (DALL·E + OpenAI TTS) and the image tools call paid
 *     APIs and wrote **zero** rows to the cost tracker. The dashboard showed the
 *     brain's LLM spend and $0 for the video pipeline — which is where the money
 *     actually goes.
 *  2. **Nothing was enforced.** `cost-tracker.checkBudget()` computes a correct
 *     verdict and has **zero callers**.
 *
 * So a retry loop against Luma could bill indefinitely while every meter in the
 * system read zero. This module records AND enforces.
 *
 * ## Why the caps default ON
 *
 * `xai-billing.ts` defaults to inactive when unconfigured, because there it
 * genuinely cannot *measure* without a credential. Here measurement is local
 * SQLite and always available, so there is no excuse to be off: a money guard
 * that ships disabled is the failure being fixed. Both caps are generous
 * relative to the audit's ~$4.24/video estimate, env-tunable, and there is one
 * explicit escape hatch.
 *
 * Environment:
 *   SUDO_MEDIA_DAILY_CAP_USD  — default 10.00
 *   SUDO_MEDIA_JOB_CAP_USD    — default 2.00 (one video)
 *   SUDO_MEDIA_CAP_DISABLE=1  — explicit opt-out. Deliberately ugly to type.
 */

import { getCostTracker } from './cost-tracker.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('media-spend');

export const DEFAULT_DAILY_CAP_USD = 10;
export const DEFAULT_JOB_CAP_USD = 2;

/**
 * Per-call cost estimates for the paid media operations, USD.
 *
 * **These are ESTIMATES from published pricing, not billed amounts**, and vendor
 * prices drift. They exist to *bound* a runaway loop, not to do accounting —
 * being 30% wrong still stops a retry storm, which is the entire point. Callers
 * that know the real number should pass `costUsd` explicitly.
 */
export const MEDIA_UNIT_COSTS: Record<string, number> = {
  'luma:video': 0.35,
  'runway:video': 0.25,
  'kling:video': 0.10,
  'openai:image-dalle': 0.08,
  'openai:image-gpt': 0.04,
  'openai:tts-1k-chars': 0.015,
};

export class MediaSpendExceededError extends Error {
  constructor(
    message: string,
    readonly scope: 'daily' | 'job',
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(message);
    this.name = 'MediaSpendExceededError';
  }
}

export interface MediaSpendConfig {
  dailyCapUsd: number;
  jobCapUsd: number;
  disabled: boolean;
}

export function readMediaSpendConfig(env: NodeJS.ProcessEnv = process.env): MediaSpendConfig {
  const num = (v: string | undefined, dflt: number): number => {
    const n = v !== undefined && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    dailyCapUsd: num(env['SUDO_MEDIA_DAILY_CAP_USD'], DEFAULT_DAILY_CAP_USD),
    jobCapUsd: num(env['SUDO_MEDIA_JOB_CAP_USD'], DEFAULT_JOB_CAP_USD),
    disabled: env['SUDO_MEDIA_CAP_DISABLE'] === '1',
  };
}

// ---------------------------------------------------------------------------
// Per-job accumulator
//
// The daily figure is persisted by the cost tracker. A *per-video* cap needs
// in-process accounting, because one video is a burst of calls inside a single
// run — exactly the shape a retry loop takes.
// ---------------------------------------------------------------------------

const jobSpend = new Map<string, number>();

/** Spend recorded so far against a job id. */
export function getJobSpend(jobId: string): number {
  return jobSpend.get(jobId) ?? 0;
}

/** Drop a job's accumulator once its pipeline finishes. */
export function clearJobSpend(jobId: string): void {
  jobSpend.delete(jobId);
}

/** Test seam. */
export function __resetAllJobSpend(): void {
  jobSpend.clear();
}

// ---------------------------------------------------------------------------
// Record + enforce
// ---------------------------------------------------------------------------

export interface MediaSpendEntry {
  /** Key into {@link MEDIA_UNIT_COSTS}, e.g. `luma:video`. */
  operation: string;
  /** Overrides the estimate when the caller knows the real cost. */
  costUsd?: number;
  /** Multiplier — e.g. chars/1000 for TTS, or an image count. */
  units?: number;
  /** Groups calls into one video for the per-job cap. */
  jobId?: string;
  latencyMs?: number;
  success?: boolean;
}

/** Resolve the USD cost of an entry from its override, or the estimate table. */
export function costOf(entry: MediaSpendEntry): number {
  const unit = entry.costUsd ?? MEDIA_UNIT_COSTS[entry.operation] ?? 0;
  return unit * (entry.units ?? 1);
}

/**
 * Record a paid media call against the cost tracker and the job accumulator.
 *
 * Media calls are priced per-unit, not per-token, so token counts are 0 and the
 * cost is supplied directly — `cost-tracker.record()` trusts a supplied cost.
 */
export function recordMediaSpend(entry: MediaSpendEntry): number {
  const cost = costOf(entry);
  const [provider = 'media'] = entry.operation.split(':');

  try {
    getCostTracker().record({
      provider,
      model: entry.operation,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: cost,
      latencyMs: entry.latencyMs ?? 0,
      success: entry.success ?? true,
      source: 'tool',
    });
  } catch (err) {
    // Never let bookkeeping break a working pipeline — but say so loudly, because
    // an unrecorded spend is an unenforced cap on the next call.
    log.error({ err: (err as Error).message, operation: entry.operation }, 'Failed to record media spend');
  }

  if (entry.jobId) jobSpend.set(entry.jobId, getJobSpend(entry.jobId) + cost);
  return cost;
}

export interface SpendCheck {
  allowed: boolean;
  reason: string;
  dailyUsd: number;
  jobUsd: number;
  dailyCapUsd: number;
  jobCapUsd: number;
}

/**
 * Would this call fit inside both caps? Pure predicate, no side effects.
 *
 * Checks the *projected* total (already spent + this call), so a single call
 * that would blow the cap is refused before it is made rather than after.
 */
export function checkMediaSpend(
  entry: MediaSpendEntry,
  cfg: MediaSpendConfig = readMediaSpendConfig(),
): SpendCheck {
  const cost = costOf(entry);
  const jobUsd = entry.jobId ? getJobSpend(entry.jobId) : 0;

  let dailyUsd = 0;
  try {
    dailyUsd = getCostTracker().getTodayCost().total;
  } catch (err) {
    // Unreadable spend is not permission to spend. Same rule as xai-billing.
    return {
      allowed: false,
      reason: `Cannot read today's spend (${(err as Error).message}) — refusing rather than assuming $0.`,
      dailyUsd: 0, jobUsd, dailyCapUsd: cfg.dailyCapUsd, jobCapUsd: cfg.jobCapUsd,
    };
  }

  const base = { dailyUsd, jobUsd, dailyCapUsd: cfg.dailyCapUsd, jobCapUsd: cfg.jobCapUsd };

  if (cfg.disabled) {
    return { ...base, allowed: true, reason: 'Media spend caps DISABLED via SUDO_MEDIA_CAP_DISABLE=1.' };
  }
  if (entry.jobId && jobUsd + cost > cfg.jobCapUsd) {
    return {
      ...base,
      allowed: false,
      reason: `Per-job cap reached: job ${entry.jobId} would hit $${(jobUsd + cost).toFixed(2)} ` +
        `against a $${cfg.jobCapUsd.toFixed(2)} cap (SUDO_MEDIA_JOB_CAP_USD).`,
    };
  }
  if (dailyUsd + cost > cfg.dailyCapUsd) {
    return {
      ...base,
      allowed: false,
      reason: `Daily cap reached: today would hit $${(dailyUsd + cost).toFixed(2)} against a ` +
        `$${cfg.dailyCapUsd.toFixed(2)} cap (SUDO_MEDIA_DAILY_CAP_USD).`,
    };
  }
  return { ...base, allowed: true, reason: `OK — $${dailyUsd.toFixed(2)}/day, $${jobUsd.toFixed(2)}/job.` };
}

/**
 * Enforce the caps. Call **before** a paid media request.
 *
 * @throws {MediaSpendExceededError} when either cap would be breached.
 */
export function assertMediaSpendAllowed(
  entry: MediaSpendEntry,
  cfg: MediaSpendConfig = readMediaSpendConfig(),
): SpendCheck {
  const check = checkMediaSpend(entry, cfg);
  if (!check.allowed) {
    const scope = check.reason.startsWith('Per-job') ? 'job' : 'daily';
    log.error({ operation: entry.operation, reason: check.reason }, 'Media spend cap HALTED a paid call');
    throw new MediaSpendExceededError(
      check.reason,
      scope,
      scope === 'job' ? check.jobUsd : check.dailyUsd,
      scope === 'job' ? check.jobCapUsd : check.dailyCapUsd,
    );
  }
  return check;
}
