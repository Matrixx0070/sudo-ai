/**
 * @file agent/mission/scheduler.ts
 * @description The clock that makes a mission progress while nobody is typing.
 *
 * Deliberately NOT bolted onto the heartbeat checklist. The heartbeat is a
 * fixed-section health sweep ("act ONLY on the sections named"), scoped to
 * short diagnostic work; missions need their own cadence, their own budget
 * accounting, and the freedom to run a real work turn. Sharing that job would
 * mean a mission step competing with a health check for the same tick.
 *
 * One tick = at most ONE advance of ONE mission (the longest-waiting eligible
 * one). Small, serial, and interruptible: a tick can never fan out into
 * unbounded parallel work, and a crash costs one step, not the mission.
 *
 * Default OFF (SUDO_MISSIONS=1 to arm) — this is the component that spends
 * money with no human in the loop, so it opts in explicitly.
 */

import { createLogger } from '../../shared/logger.js';
import { nextAdvanceableMission } from './store.js';
import { advanceMission, type AdvanceDeps, type AdvanceOutcome } from './runner.js';

const log = createLogger('agent:mission:scheduler');

/** Minutes between ticks. Clamped to [5, 720]; default 30. */
export function tickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env['SUDO_MISSION_TICK_MIN'] ?? '', 10);
  const min = Number.isFinite(raw) && raw >= 5 && raw <= 720 ? raw : 30;
  return min * 60_000;
}

/** True when autonomous mission advancement is armed (default OFF). */
export function missionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_MISSIONS'] === '1';
}

/**
 * Run a single tick: advance the longest-waiting eligible mission, if any.
 * Never throws — the caller is a timer that must survive every outcome.
 */
export async function missionTick(deps: AdvanceDeps): Promise<AdvanceOutcome> {
  try {
    const mission = nextAdvanceableMission();
    if (!mission) return { kind: 'idle', reason: 'no advanceable mission' };

    log.info(
      { missionId: mission.id, status: mission.status, cursor: mission.cursor, spendUsd: mission.spendUsd },
      'Mission tick — advancing',
    );
    const outcome = await advanceMission(mission, deps);
    log.info({ missionId: mission.id, outcome: outcome.kind }, 'Mission tick complete');
    return outcome;
  } catch (err) {
    log.warn({ err: String(err) }, 'Mission tick threw (non-fatal)');
    return { kind: 'idle', reason: String(err).slice(0, 200) };
  }
}

/**
 * Arm the recurring tick. Returns a stop function; caller registers it with the
 * process shutdown hooks. No-op (and says so) when the flag is off.
 */
export function startMissionScheduler(deps: AdvanceDeps, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!missionsEnabled(env)) {
    log.info('Mission scheduler NOT started (SUDO_MISSIONS != 1)');
    return () => { /* nothing armed */ };
  }
  const intervalMs = tickIntervalMs(env);
  let running = false;
  const timer = setInterval(() => {
    // Serial by construction: a slow advance must not overlap the next tick.
    if (running) {
      log.info('Mission tick skipped — previous tick still running');
      return;
    }
    running = true;
    void missionTick(deps).finally(() => { running = false; });
  }, intervalMs);
  // Never hold the event loop open for a background clock.
  if (typeof timer.unref === 'function') timer.unref();
  log.info({ intervalMin: intervalMs / 60_000 }, 'Mission scheduler armed');
  return () => clearInterval(timer);
}
