/**
 * @file tool-outcome-learner.ts
 * @description ToolOutcomeLearner — single integration point for all learning modules.
 *
 * Feeds tool execution outcomes into the learning system:
 * - FailureLearner: records failures, provides prevention rules
 * - ImprovementLoop: records strengths/weaknesses from actions
 * - SkillDiscovery: records tool call success/fail per skill
 * - AgentConfigEvolver: records traces for config evolution
 * - TrustTierTracker: records outcomes for trust scoring
 * - ConfidenceCalibrationTracker: records predicted vs actual confidence
 *
 * Kill-switch: SUDO_TOOL_LEARNING_DISABLE=1 disables all learning
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:tool-outcome-learner');

// ---------------------------------------------------------------------------
// Duck-typed interfaces — avoid circular imports
// ---------------------------------------------------------------------------

export interface FailureLearnerLike {
  recordFailure(tool: string, error: string, context: string): unknown;
  getPreventionRule(tool: string, error: string): string | undefined;
  hasSeenBefore(tool: string, error: string): boolean;
  getSolution(tool: string, error: string): string | undefined;
  /**
   * Attach a solution + optional prevention rule to a prior failure (by id).
   * Optional so duck-typed wirings that predate the recovery producer still
   * satisfy the interface; the producer guards on its presence at call time.
   */
  recordSolution?(failureId: string, solution: string, preventionRule?: string): void;
}

export interface ImprovementLoopLike {
  recordInsight(
    type: 'weakness' | 'strength' | 'opportunity' | 'pattern',
    description: string,
    source: string,
  ): unknown;
}

export interface SkillDiscoveryLike {
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
}

export interface AgentConfigEvolverLike {
  recordTrace(trace: {
    sessionId: string;
    agentId: string;
    toolSequence: string[];
    quality: number;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }): void;
}

export interface TrustTierTrackerLike {
  recordOutcome(outcome: {
    timestamp: number;
    kind: string;
    weight?: number;
  }): void;
}

export interface ConfidenceCalibrationTrackerLike {
  record(predicted: number, outcome: 0 | 1, tag?: string, toolName?: string): void;
}

export interface ToolOutcome {
  toolName: string;
  success: boolean;
  error?: string;
  predictedConfidence?: number;
  epistemicTag?: string;
}

export interface SessionEndData {
  sessionId: string;
  outcomes: ToolOutcome[];
}

/** An in-session failure awaiting a same-tool success to mark it recovered. */
interface PendingFailure {
  failureId: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Dependencies container
// ---------------------------------------------------------------------------

export interface ToolOutcomeLearnerDeps {
  failureLearner?: FailureLearnerLike;
  improvementLoop?: ImprovementLoopLike;
  skillDiscovery?: SkillDiscoveryLike;
  agentConfigEvolver?: AgentConfigEvolverLike;
  trustTierTracker?: TrustTierTrackerLike;
  confidenceCalibrationTracker?: ConfidenceCalibrationTrackerLike;
}

// ---------------------------------------------------------------------------
// ToolOutcomeLearner
// ---------------------------------------------------------------------------

export class ToolOutcomeLearner {
  private readonly failureLearner?: FailureLearnerLike;
  private readonly improvementLoop?: ImprovementLoopLike;
  private readonly skillDiscovery?: SkillDiscoveryLike;
  private readonly agentConfigEvolver?: AgentConfigEvolverLike;
  private readonly trustTierTracker?: TrustTierTrackerLike;
  private readonly confidenceCalibrationTracker?: ConfidenceCalibrationTrackerLike;
  private readonly learningDisabled: boolean;

  /**
   * In-session unresolved failures, keyed by `${sessionId}:${toolName}`.
   * When the same tool later succeeds, the latest entry is resolved into a
   * stored solution + prevention rule (the recovery producer). Bounded per key
   * and cleared on session end so it cannot grow without limit.
   */
  private readonly pendingFailures = new Map<string, PendingFailure[]>();
  private static readonly MAX_PENDING_PER_KEY = 50;

  constructor(deps: ToolOutcomeLearnerDeps = {}) {
    this.failureLearner = deps.failureLearner;
    this.improvementLoop = deps.improvementLoop;
    this.skillDiscovery = deps.skillDiscovery;
    this.agentConfigEvolver = deps.agentConfigEvolver;
    this.trustTierTracker = deps.trustTierTracker;
    this.confidenceCalibrationTracker = deps.confidenceCalibrationTracker;

    // Kill-switch: SUDO_TOOL_LEARNING_DISABLE=1
    this.learningDisabled = process.env['SUDO_TOOL_LEARNING_DISABLE'] === '1';

    if (this.learningDisabled) {
      log.warn('ToolOutcomeLearner disabled via SUDO_TOOL_LEARNING_DISABLE=1');
    } else {
      log.info('ToolOutcomeLearner initialized');
    }
  }

  /**
   * Called after EVERY tool execution (success or failure).
   *
   * @param toolName - Name of the tool that executed
   * @param args - Tool arguments (for context)
   * @param success - Whether the tool call succeeded
   * @param error - Error message if failed
   * @param sessionId - Session identifier
   * @param predictedConfidence - Predicted confidence (0-1) for calibration tracking
   * @param epistemicTag - Epistemic tag for calibration tracking
   */
  onToolResult(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    error?: string,
    sessionId?: string,
    predictedConfidence?: number,
    epistemicTag?: string,
  ): void {
    if (this.learningDisabled) {
      return;
    }

    if (!toolName) {
      log.warn('onToolResult: toolName is required');
      return;
    }

    const context = JSON.stringify(args).slice(0, 200);
    const timestamp = Date.now();

    // a. If failed: call FailureLearner.record() and remember the id so a later
    //    same-tool success can attach a solution (the recovery producer).
    if (!success && error && this.failureLearner) {
      try {
        const rec = this.failureLearner.recordFailure(toolName, error, context) as
          | { id?: string }
          | undefined;
        log.debug({ tool: toolName, error: error.slice(0, 50) }, 'Failure recorded');
        if (rec?.id && typeof this.failureLearner.recordSolution === 'function') {
          this._trackPendingFailure(sessionId, toolName, rec.id, error);
        }
      } catch (err) {
        log.warn({ err, tool: toolName }, 'FailureLearner.recordFailure failed');
      }
    }

    // a2. Recovery producer: if this tool previously failed in-session and now
    //     succeeded, attach a solution + prevention rule so future sessions can
    //     short-circuit the same mistake. Deterministic — no model call.
    if (success && this.failureLearner && typeof this.failureLearner.recordSolution === 'function') {
      const recovered = this._takeLatestPendingFailure(sessionId, toolName);
      if (recovered) {
        try {
          const working = context; // current (successful) args, already trimmed
          const errPrefix = recovered.error.slice(0, 80);
          const solution = `Recovered on a later call in the same session. Working arguments: ${working}`;
          const preventionRule =
            `"${toolName}" previously failed with "${errPrefix}". ` +
            `A later call in the same session succeeded using these arguments: ${working}. ` +
            `Compare your arguments against that before retrying.`;
          this.failureLearner.recordSolution(recovered.failureId, solution, preventionRule);
          log.info({ tool: toolName }, 'Recovery recorded — solution + prevention rule stored');
        } catch (err) {
          log.warn({ err, tool: toolName }, 'FailureLearner.recordSolution failed');
        }
      }
    }

    // b. If failed: check for existing prevention rules
    // (guarded like every other sink: the SQLite-backed FailureLearner can
    // throw on runtime DB errors, and this runs on the loop's hot path)
    if (!success && error && this.failureLearner) {
      try {
        const rule = this.failureLearner.getPreventionRule(toolName, error);
        if (rule) {
          log.info({ tool: toolName, rule: rule.slice(0, 100) }, 'Prevention rule found');
        }
      } catch (err) {
        log.warn({ err, tool: toolName }, 'FailureLearner.getPreventionRule failed');
      }
    }

    // c. Call ImprovementLoop.recordInsight() with action outcome
    if (this.improvementLoop) {
      try {
        const type: 'weakness' | 'strength' | 'pattern' = success ? 'strength' : 'weakness';
        const description = success
          ? `Tool "${toolName}" executed successfully`
          : `Tool "${toolName}" failed: ${error?.slice(0, 100) ?? 'unknown error'}`;
        this.improvementLoop.recordInsight(type, description, 'tool-outcome-learner');
      } catch (err) {
        log.warn({ err, tool: toolName }, 'ImprovementLoop.recordInsight failed');
      }
    }

    // d. Call SkillDiscovery.recordToolCall() if attached
    if (this.skillDiscovery && sessionId) {
      try {
        this.skillDiscovery.recordToolCall(sessionId, toolName, success);
      } catch (err) {
        log.warn({ err, tool: toolName }, 'SkillDiscovery.recordToolCall failed');
      }
    }

    // e. Call AgentConfigEvolver.recordTrace() if attached
    // Note: This is a per-tool call; full sequence traces are recorded at session end
    if (this.agentConfigEvolver && sessionId) {
      try {
        this.agentConfigEvolver.recordTrace({
          sessionId,
          agentId: sessionId, // proxy — loop has no separate agentId concept
          toolSequence: [toolName],
          quality: success ? 1 : 0,
          timestamp: new Date().toISOString(),
          metadata: { error: error ?? null },
        });
      } catch (err) {
        log.warn({ err, tool: toolName }, 'AgentConfigEvolver.recordTrace failed');
      }
    }

    // f. Call TrustTierTracker.recordOutcome() for trust scoring
    if (this.trustTierTracker) {
      try {
        const kind = success ? 'success' : 'failure';
        this.trustTierTracker.recordOutcome({
          timestamp,
          kind,
        });
      } catch (err) {
        log.warn({ err, tool: toolName }, 'TrustTierTracker.recordOutcome failed');
      }
    }

    // g. Call ConfidenceCalibrationTracker.record() if confidence was predicted
    if (this.confidenceCalibrationTracker) {
      try {
        const outcome: 0 | 1 = success ? 1 : 0;
        this.confidenceCalibrationTracker.record(
          predictedConfidence ?? 0.5,
          outcome,
          epistemicTag ?? 'tool-outcome',
          toolName,
        );
      } catch (err) {
        log.warn({ err, tool: toolName }, 'ConfidenceCalibrationTracker.record failed');
      }
    }
  }

  /**
   * Called when a session ends.
   * Feeds outcomes to TrustTierTracker and ConfidenceCalibrationTracker.
   *
   * @param sessionId - Session identifier
   * @param outcomes - Array of tool outcomes from the session
   */
  onSessionEnd(sessionId: string, outcomes: ToolOutcome[]): void {
    if (this.learningDisabled) {
      return;
    }

    if (!sessionId || !outcomes || outcomes.length === 0) {
      return;
    }

    const timestamp = Date.now();

    // Feed outcomes to TrustTierTracker
    if (this.trustTierTracker) {
      for (const outcome of outcomes) {
        try {
          const kind = outcome.success ? 'success' : 'failure';
          this.trustTierTracker.recordOutcome({
            timestamp,
            kind,
          });
        } catch (err) {
          log.warn({ err, sessionId }, 'TrustTierTracker session-end recording failed');
        }
      }
    }

    // Feed predictions vs outcomes to ConfidenceCalibrationTracker
    if (this.confidenceCalibrationTracker) {
      for (const outcome of outcomes) {
        try {
          const result: 0 | 1 = outcome.success ? 1 : 0;
          this.confidenceCalibrationTracker.record(
            outcome.predictedConfidence ?? 0.5,
            result,
            outcome.epistemicTag ?? 'session-end',
            outcome.toolName,
          );
        } catch (err) {
          log.warn({ err, sessionId }, 'ConfidenceCalibrationTracker session-end recording failed');
        }
      }
    }

    // Drop any unresolved in-session pending failures for this session so the
    // pending map does not retain state across sessions.
    const prefix = `${sessionId}:`;
    for (const key of this.pendingFailures.keys()) {
      if (key.startsWith(prefix)) this.pendingFailures.delete(key);
    }

    log.info({ sessionId, outcomeCount: outcomes.length }, 'Session end recorded');
  }

  // -------------------------------------------------------------------------
  // Recovery-producer helpers (in-session failure → success tracking)
  // -------------------------------------------------------------------------

  private _pendingKey(sessionId: string | undefined, toolName: string): string {
    return `${sessionId ?? 'no-session'}:${toolName}`;
  }

  /** Remember an unresolved failure so a later same-tool success can resolve it. */
  private _trackPendingFailure(
    sessionId: string | undefined,
    toolName: string,
    failureId: string,
    error: string,
  ): void {
    const key = this._pendingKey(sessionId, toolName);
    const bucket = this.pendingFailures.get(key) ?? [];
    bucket.push({ failureId, error });
    if (bucket.length > ToolOutcomeLearner.MAX_PENDING_PER_KEY) {
      bucket.splice(0, bucket.length - ToolOutcomeLearner.MAX_PENDING_PER_KEY);
    }
    this.pendingFailures.set(key, bucket);
  }

  /** Pop the most recent unresolved failure for a session+tool, if any (LIFO). */
  private _takeLatestPendingFailure(
    sessionId: string | undefined,
    toolName: string,
  ): PendingFailure | undefined {
    const key = this._pendingKey(sessionId, toolName);
    const bucket = this.pendingFailures.get(key);
    if (!bucket || bucket.length === 0) return undefined;
    const latest = bucket.pop();
    if (bucket.length === 0) this.pendingFailures.delete(key);
    return latest;
  }

  /**
   * Check prevention rules for a specific tool and error combination.
   * Returns a hint when a pattern exists.
   *
   * @param toolName - Name of the tool
   * @param error - Error message to check against known patterns
   * @returns A hint string if a pattern exists, or null if no known patterns
   */
  checkPreventionRulesForError(toolName: string, error: string): string | null {
    if (this.learningDisabled) {
      return null;
    }

    if (!toolName || !error || !this.failureLearner) {
      return null;
    }

    try {
      const rule = this.failureLearner.getPreventionRule(toolName, error);
      if (rule) {
        return `This tool failed last time with: "${error.slice(0, 50)}...". Prevention rule: ${rule}`;
      }

      const solution = this.failureLearner.getSolution(toolName, error);
      if (solution) {
        return `This tool failed last time with: "${error.slice(0, 50)}...". Known solution: ${solution}`;
      }

      if (this.failureLearner.hasSeenBefore(toolName, error)) {
        return `This tool has failed before with a similar error: "${error.slice(0, 50)}..."`;
      }
    } catch (err) {
      log.warn({ err, tool: toolName }, 'checkPreventionRulesForError failed');
    }

    return null;
  }
}
