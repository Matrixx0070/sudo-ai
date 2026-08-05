/**
 * @file agent/mission/wake.ts
 * @description Event-driven, busy-gated wake for mission advancement.
 *
 * WHY THIS REPLACES A PLAIN setInterval (2026-08-05, Frank's catch): the first
 * mission scheduler was a blind 30-minute timer, which is wrong in both
 * directions and does not match the heartbeat design this system was built
 * from (OpenClaw's `heartbeat-wake`):
 *
 *   - TOO SLOW: a mission created while the machine is idle sat untouched for
 *     up to 30 minutes. Nothing was happening; there was no reason to wait.
 *     OpenClaw wakes on an EVENT (`requestHeartbeat`) and merely coalesces
 *     bursts; the interval is a floor, not the driver.
 *   - TOO EAGER: the timer fired regardless of what the machine was doing, so
 *     an autonomous work turn could land while the owner was mid-conversation.
 *     OpenClaw gates every wake on the system being free
 *     (`requests-in-flight` / `cron-in-progress` / `lanes-busy`) and RETRIES
 *     the skip instead of dropping it.
 *
 * So: a mission advances as soon as there is a reason to and nothing else is
 * running — and never while the owner is being served.
 */

import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent:mission:wake');

/** Collapse a burst of wake requests into one tick. */
const DEFAULT_COALESCE_MS = 1_500;
/** How soon to re-try after a busy skip. */
const BUSY_RETRY_MS = 60_000;
/**
 * Gap between chained steps of the same mission. Short on purpose: this is a
 * deliberate continuation, not a burst to collapse, so it should not sit in the
 * coalesce window. Non-zero so the event loop (and any arriving user turn, via
 * the busy gate) gets a chance between steps.
 */
const CHAIN_MS = 250;

export type WakeReason =
  | 'mission-created'
  | 'mission-unblocked'
  | 'mission-resumed'
  | 'step-advanced'
  | 'user-idle'
  | 'interval'
  | 'startup';

/** Injected so this module owns no runtime handles and stays testable. */
export interface WakeDeps {
  /** Run one tick. Resolves when the tick is finished. */
  tick: () => Promise<{ kind: string }>;
  /** True when the system is serving someone — a wake must not interrupt. */
  isBusy: () => boolean;
  /** True when there is at least one mission that could advance. */
  hasWork: () => boolean;
}

let deps: WakeDeps | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
const pending = new Set<WakeReason>();

/** Install the runtime deps. Returns a teardown that disarms everything. */
export function setWakeDeps(next: WakeDeps | null): () => void {
  deps = next;
  return () => {
    deps = null;
    if (timer) { clearTimeout(timer); timer = null; }
    pending.clear();
  };
}

function schedule(delayMs: number): void {
  if (timer || !deps) return;
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function drain(): Promise<void> {
  if (!deps || running) return;
  const reasons = [...pending];
  pending.clear();
  if (reasons.length === 0) return;

  // Busy gate — re-queue rather than drop, so a wake is deferred, never lost.
  if (deps.isBusy()) {
    log.info({ reasons }, 'Mission wake skipped — system busy; retrying shortly');
    for (const r of reasons) pending.add(r);
    schedule(BUSY_RETRY_MS);
    return;
  }
  if (!deps.hasWork()) return;

  running = true;
  try {
    const outcome = await deps.tick();
    log.info({ reasons, outcome: outcome.kind }, 'Mission wake tick complete');
    // Chain: while the machine is idle and work remains, keep going instead of
    // sleeping a full interval between steps. This is what turns "one step per
    // 30 minutes" into "a mission runs until it is done, blocked, or the owner
    // needs the machine".
    if (outcome.kind === 'planned' || outcome.kind === 'advanced' || outcome.kind === 'retry') {
      requestMissionWake('step-advanced', CHAIN_MS);
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Mission wake tick threw (non-fatal)');
  } finally {
    running = false;
  }
}

/**
 * Ask for a mission tick. Safe to call from anywhere, any number of times —
 * requests coalesce, and a request while busy defers rather than interrupts.
 * No-op until deps are installed (flag off / not yet wired).
 */
export function requestMissionWake(reason: WakeReason, coalesceMs = DEFAULT_COALESCE_MS): void {
  if (!deps) return;
  pending.add(reason);
  schedule(coalesceMs);
}

/** Test seam: true when a wake is queued or scheduled. */
export function hasPendingWake(): boolean {
  return pending.size > 0 || timer !== null;
}

/** Test seam. */
export function __resetWakeForTests(): void {
  deps = null;
  if (timer) { clearTimeout(timer); timer = null; }
  pending.clear();
  running = false;
}
