/**
 * @file agency-monitor.ts
 * @description CW7 — cheap agency / efference (SUDO_CAS_AGENCY, default OFF).
 *
 * For high-stakes, deterministic tools (coder.* + system.exec) the agent's
 * IMPLICIT expectation is "this succeeds — exit 0 / no error". We capture that
 * expectation at dispatch and compare it against the actual result. A mismatch
 * (expected success, got failure) is an efference-copy violation: the world did
 * not do what the action intended.
 *
 * On mismatch, two conservative effects — NO new LLM calls, expectation derived
 * purely from the tool identity/args already in hand:
 *   (a) a doom-loop-visible signal: doomLoopDetector.registerMismatch(tool), so
 *       a chronically-failing tool trips the doom warning in fewer repeats;
 *   (b) a small negative EMA nudge on the tool-bias (store.penalize, <= one EMA
 *       step) ON TOP OF the normal record(false) — expectation violation is a
 *       stronger negative signal than a merely-flaky tool.
 *
 * Scope is deliberately narrow (handoff CW7): only tools whose success is
 * deterministic enough that "no error" is a sound default expectation.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:agency');

/** Duck-typed EMA store surface (tool-success-store.ts). */
export interface BiasStoreLike {
  penalize(tool: string, factor?: number): void;
}

/** Duck-typed doom detector surface (doom-loop.ts). */
export interface DoomSignalLike {
  registerMismatch(tool: string): void;
}

/** Implicit expectation for an in-scope tool call, captured at dispatch. */
export interface ToolExpectation {
  toolName: string;
  /** Deterministic tools are expected to complete without error (exit 0). */
  expectSuccess: true;
}

/**
 * In scope: exec-class + coder tools. These are the high-stakes, deterministic
 * tools where "no error" is a sound default expectation.
 */
export function isInScope(toolName: string): boolean {
  return toolName === 'system.exec' || toolName.startsWith('coder.');
}

/**
 * Capture-at-dispatch. Returns the implicit expectation for an in-scope tool,
 * or null for out-of-scope tools (they are not monitored). `_args` is reserved
 * for future richer, reasoning-derived expectations — today the default is
 * deterministic so the identity suffices (zero new LLM calls either way).
 */
export function captureExpectation(
  toolName: string,
  _args?: Record<string, unknown>,
): ToolExpectation | null {
  if (!isInScope(toolName)) return null;
  return { toolName, expectSuccess: true };
}

/**
 * Monitors expected-vs-actual for in-scope tool calls. Holds an in-memory
 * per-tool mismatch counter (surfaced for Telemetry via snapshot()). All
 * effects are conservative and fail-open.
 */
export class AgencyMonitor {
  private readonly store: BiasStoreLike;
  private readonly doom: DoomSignalLike;
  private readonly mismatches = new Map<string, number>();

  constructor(store: BiasStoreLike, doom: DoomSignalLike) {
    this.store = store;
    this.doom = doom;
  }

  /**
   * Compare-at-result. Given the dispatch expectation and the actual outcome,
   * fire the mismatch effects when the expectation was violated.
   *
   * @returns true when a mismatch was recorded, false otherwise.
   */
  onToolResult(
    expectation: ToolExpectation | null,
    actualSuccess: boolean,
    sessionId?: string,
  ): boolean {
    if (!expectation) return false;
    // expectSuccess is always true for in-scope tools => mismatch == failure.
    if (actualSuccess) return false;

    const tool = expectation.toolName;
    this.mismatches.set(tool, (this.mismatches.get(tool) ?? 0) + 1);

    try { this.doom.registerMismatch(tool); } catch (err) { log.warn({ err: String(err) }, 'agency: doom signal failed (fail-open)'); }
    try { this.store.penalize(tool); } catch (err) { log.warn({ err: String(err) }, 'agency: bias penalize failed (fail-open)'); }

    log.info(
      { tool, sessionId, mismatchCount: this.mismatches.get(tool), event: 'agency_mismatch' },
      'CW7: tool expectation violated (expected success, got failure)',
    );
    return true;
  }

  /** Telemetry snapshot: per-tool mismatch counts, worst-first. */
  snapshot(): Array<{ tool: string; mismatches: number }> {
    return [...this.mismatches.entries()]
      .map(([tool, mismatches]) => ({ tool, mismatches }))
      .sort((a, b) => b.mismatches - a.mismatches);
  }

  /** Total mismatches across all tools (single Telemetry scalar). */
  totalMismatches(): number {
    let t = 0;
    for (const v of this.mismatches.values()) t += v;
    return t;
  }
}
