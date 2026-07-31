/**
 * @file src/core/tools/builtin/coder/kairos-repair-gate.ts
 * @description Dedupe latch + per-day budget for the KAIROS→arsenal repair
 * loop. Split out of arsenal.ts (max-lines ratchet) — this is a cohesive unit:
 * decide whether an autonomous repair RUN is allowed at all.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('coder.kairos-gate');

/**
 * Dedupe + budget state for the KAIROS repair loop. Persisted to disk because
 * the in-memory-only latch re-ran the full ~80k-token pipeline after EVERY
 * daemon restart for an unchanged observation (live-proven 2026-07-31: six
 * restarts → six full re-runs, one minute after each). Fail-open on IO errors:
 * a broken latch file degrades to the old in-memory behaviour, never blocks.
 */
interface KairosLatchState {
  attemptedKey: string;
  proposalKey: string;
  /** UTC day (YYYY-MM-DD) the run counter belongs to. */
  day: string;
  runsToday: number;
}

let latchFile = path.join(PROJECT_ROOT, 'data', 'kairos-repair-latch.json');
let latch: KairosLatchState | null = null;

function loadLatch(): KairosLatchState {
  if (latch) return latch;
  latch = { attemptedKey: '', proposalKey: '', day: '', runsToday: 0 };
  try {
    if (existsSync(latchFile)) {
      const raw = JSON.parse(readFileSync(latchFile, 'utf-8')) as Partial<KairosLatchState>;
      if (typeof raw.attemptedKey === 'string') latch.attemptedKey = raw.attemptedKey;
      if (typeof raw.proposalKey === 'string') latch.proposalKey = raw.proposalKey;
      if (typeof raw.day === 'string') latch.day = raw.day;
      if (typeof raw.runsToday === 'number' && raw.runsToday >= 0) latch.runsToday = raw.runsToday;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KAIROS latch file unreadable — starting fresh (fail-open)');
  }
  return latch;
}

function saveLatch(): void {
  if (!latch) return;
  try {
    mkdirSync(path.dirname(latchFile), { recursive: true });
    writeFileSync(latchFile, JSON.stringify(latch));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KAIROS latch file write failed — dedupe stays in-memory (fail-open)');
  }
}

/** Test hook: drop in-memory state but KEEP the latch file — simulates a daemon restart. */
export function _simulateKairosRestartForTests(): void {
  latch = null;
}

export function _resetKairosProposalDedupeForTests(file?: string): void {
  latch = null;
  if (file) latchFile = file;
  try { if (existsSync(latchFile)) unlinkSync(latchFile); } catch { /* test-only best effort */ }
}

/**
 * Strip volatile counters from a KAIROS observation so the dedupe key tracks
 * WHAT is flagged (mode + file set / error codes), not cosmetic drift. Without
 * this, one line added to any of 37 oversized files re-keyed the observation
 * and re-analysed all 37 from scratch.
 */
export function normalizeKairosObservation(task: string): string {
  // Strip per-file line counts and tsc positions (pure drift), but KEEP the
  // "N file(s)" / "N error(s)" counts: kairos truncates the listed files, so
  // the count is the only signal when a file outside the visible list is
  // added or removed — a genuinely new observation that must still run.
  return task
    .replace(/\(\d+ lines\)/g, '(lines)')      // "loop.ts (3679 lines)" — line counts drift
    .replace(/\((\d+),(\d+)\)/g, '(pos)');      // "file.ts(123,4): error TS…" — positions drift
}

function observationKey(task: string, mode: 'fix' | 'refactor'): string {
  return createHash('sha256').update(`${mode}\n${normalizeKairosObservation(task)}`).digest('hex');
}

/**
 * True when this observation has not been analysed yet (and latches it). Gates
 * the LLM call itself, not just persistence — an unchanged observation yields
 * an identical analysis we already hold, at ~80k input + 32,768 output tokens
 * a tick.
 */
export function isNewKairosObservation(task: string, mode: 'fix' | 'refactor'): boolean {
  const state = loadLatch();
  const key = observationKey(task, mode);
  if (key === state.attemptedKey) return false;
  state.attemptedKey = key;
  saveLatch();
  return true;
}

/**
 * True when this observation differs from the last one persisted (and latches
 * it). Deliberately separate state from the attempted latch: that one latches
 * on ATTEMPT; sharing one key would make the persist check always return
 * false, silently dropping every proposal.
 */
export function shouldPersistKairosProposal(task: string, mode: 'fix' | 'refactor'): boolean {
  const state = loadLatch();
  const key = observationKey(task, mode);
  if (key === state.proposalKey) return false;
  state.proposalKey = key;
  saveLatch();
  return true;
}

/**
 * ADR-0006: the timer-driven repair loop is demoted to demand-driven. When
 * SUDO_KAIROS_REPAIR_DEMAND_ONLY=1 the KAIROS tick still OBSERVES (large-file
 * and tsc checks are cheap and deterministic) but never fires the ~80k-token
 * arsenal analysis on its own; the analysis runs only on owner command
 * (coder.arsenal) or from the weekly digest cron, which calls the arsenal
 * tool directly and so bypasses this gate by construction.
 */
export function isKairosRepairDemandOnly(): boolean {
  return process.env['SUDO_KAIROS_REPAIR_DEMAND_ONLY'] === '1';
}

/**
 * Per-day run budget for the KAIROS repair loop (CLAUDE.md invariant 10:
 * every recurring background job declares budgets). Counts pipeline RUNS that
 * passed the dedupe gate, per UTC day, persisted across restarts. Returns true
 * and increments when a run is allowed. SUDO_KAIROS_REPAIR_MAX_PER_DAY:
 * default 4; 0 blocks all runs (kill switch); invalid/negative → default.
 */
export function consumeKairosRepairBudget(): { allowed: boolean; used: number; max: number } {
  const raw = Number.parseInt(process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] ?? '', 10);
  const max = Number.isFinite(raw) && raw >= 0 ? raw : 4;
  const state = loadLatch();
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.runsToday = 0;
  }
  if (state.runsToday >= max) return { allowed: false, used: state.runsToday, max };
  state.runsToday += 1;
  saveLatch();
  return { allowed: true, used: state.runsToday, max };
}
