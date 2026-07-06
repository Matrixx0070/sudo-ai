/**
 * @file loop-exit-guard.ts
 * @description Composable exit-guard pipeline for the agent's outer loop.
 *
 * A "guard" is an object with a name and a synchronous or async `check(ctx)`
 * that returns a decision. The runner walks the list in order and returns the
 * first non-`continue` verdict; the loop honours it.
 *
 * Live wiring: loop.ts runs the StuckDetector post-tool scan through this
 * chain (fromAllowWarnAbortCheck adapter) — the warn/abort side effects
 * (system-message injection, swarm-rescue latch, abort text) stay in the
 * loop, keyed off the returned verdict. Further gates (TodoGate,
 * GoalStopDetector, SelfVerify) can migrate onto the same chain
 * incrementally.
 *
 * Verdict semantics:
 *   'continue' — let the loop keep going.
 *   'warn'     — let the loop keep going BUT bubble the message back so
 *                the orchestrator can inject a nudge into the next turn.
 *   'exit'     — stop the loop immediately; reason becomes the exit code.
 *
 * Priority when a single guard returns 'exit' AND a later guard hasn't
 * run yet: 'exit' short-circuits. Multiple 'warn's are collected so the
 * orchestrator can compose them into one nudge if it wants.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:loop-exit-guard');

export type LoopExitAction = 'continue' | 'warn' | 'exit';

export interface LoopExitDecision {
  action: LoopExitAction;
  /** Human-readable rationale. Required for warn/exit, optional for continue. */
  reason?: string;
  /** Name of the guard that produced this decision (filled by the runner). */
  guard?: string;
}

/**
 * The check a single guard exposes. Implementations are intentionally tiny —
 * the goal is to let an existing detector be wrapped in 3 lines.
 */
export interface LoopExitGuardCheck<Ctx = unknown> {
  /** Stable identifier — appears in logs and decision.guard. */
  name: string;
  /**
   * Decide whether the loop should continue, warn, or exit.
   * Synchronous or async; the runner awaits either way.
   */
  check(ctx: Ctx): LoopExitDecision | Promise<LoopExitDecision>;
}

export interface RunResult {
  /** The action the loop should take. */
  action: LoopExitAction;
  /** Aggregate reason — the exit reason on exit, or joined warn reasons. */
  reason: string;
  /** Name of the guard that ultimately decided. Empty when no guard fired. */
  decidedBy: string;
  /** All warn decisions collected before any exit short-circuit. */
  warnings: LoopExitDecision[];
}

/**
 * Run a chain of guards in declaration order against `ctx`.
 *
 * - Returns `{action: 'exit'}` the moment any guard says exit.
 * - Otherwise returns `{action: 'warn'}` with all collected warns when at
 *   least one guard warned.
 * - Otherwise returns `{action: 'continue'}`.
 *
 * A guard that throws is logged and treated as `continue` (fail-open) so a
 * single buggy detector cannot freeze the agent loop.
 */
export async function runLoopExitGuardChain<Ctx>(
  guards: ReadonlyArray<LoopExitGuardCheck<Ctx>>,
  ctx: Ctx,
): Promise<RunResult> {
  const warnings: LoopExitDecision[] = [];

  for (const guard of guards) {
    let decision: LoopExitDecision;
    try {
      decision = await guard.check(ctx);
    } catch (err) {
      log.warn({ guard: guard.name, err: String(err) }, 'LoopExitGuard check threw — treating as continue (fail-open)');
      continue;
    }

    decision.guard = guard.name;

    if (decision.action === 'exit') {
      log.info({ guard: guard.name, reason: decision.reason }, 'LoopExitGuard chain → EXIT');
      return {
        action: 'exit',
        reason: decision.reason ?? `exit by ${guard.name}`,
        decidedBy: guard.name,
        warnings,
      };
    }

    if (decision.action === 'warn') {
      warnings.push(decision);
    }
  }

  if (warnings.length > 0) {
    const merged = warnings
      .map((w) => `${w.guard}: ${w.reason ?? '(no reason)'}`)
      .join(' | ');
    return {
      action: 'warn',
      reason: merged,
      decidedBy: warnings.map((w) => w.guard ?? '?').join(','),
      warnings,
    };
  }

  return { action: 'continue', reason: '', decidedBy: '', warnings: [] };
}

/**
 * Convenience helper to adapt the existing detectors that return a `{action:
 * 'allow'|'warn'|'abort', reason?}` shape (StuckDetector, LoopGuard, etc.)
 * into a LoopExitGuardCheck. The `allow → continue` and `abort → exit`
 * mappings are byte-stable.
 */
export function fromAllowWarnAbortCheck<Ctx>(
  name: string,
  fn: (ctx: Ctx) => { action: 'allow' | 'warn' | 'abort'; reason?: string } | Promise<{ action: 'allow' | 'warn' | 'abort'; reason?: string }>,
): LoopExitGuardCheck<Ctx> {
  return {
    name,
    async check(ctx) {
      const raw = await fn(ctx);
      const mapped: LoopExitAction =
        raw.action === 'allow' ? 'continue' : raw.action === 'warn' ? 'warn' : 'exit';
      return { action: mapped, reason: raw.reason };
    },
  };
}
