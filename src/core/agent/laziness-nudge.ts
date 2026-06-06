/**
 * @file laziness-nudge.ts
 * @description Laziness Classifier & Proactivity Nudge — detects idle/passive
 * agent behavior and sends proactivity reminders. Grok Build CLI parity.
 *
 * Grok's approach:
 *   - Laziness Classifier with confidence-based detection
 *   - Configurable cadence (how often to check) and threshold (how many turns idle)
 *   - Emits laziness_classifier_fired and laziness_nudge_fired telemetry events
 *   - Injects system message nudges to prompt the agent to take action
 *
 * SUDO-AI enhances this with:
 *   - Tool-call gap detection (no tool calls in N turns)
 *   - Text-only response detection (agent talks but doesn't act)
 *   - Confidence scoring for the laziness classification
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:laziness-nudge');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How many consecutive turns with no tool calls before triggering laziness detection. */
export const LAZINESS_CADENCE: number =
  Number(process.env['SUDO_LAZINESS_CADENCE']) || 3;

/** Confidence threshold for laziness classification (0-1). */
export const LAZINESS_THRESHOLD: number =
  Number(process.env['SUDO_LAZINESS_THRESHOLD']) || 0.7;

/** Whether laziness nudge is enabled. */
export const LAZINESS_NUDGE_ENABLED: boolean =
  process.env['SUDO_LAZINESS_NUDGE'] !== '0'; // enabled by default

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LazinessLevel = 'active' | 'mild_idle' | 'idle' | 'very_idle';

export interface LazinessClassification {
  /** Detected laziness level. */
  level: LazinessLevel;
  /** Confidence in the classification (0-1). */
  confidence: number;
  /** Number of consecutive turns with no tool calls. */
  idleTurnCount: number;
  /** Evidence for the classification. */
  evidence: string[];
  /** Whether a nudge was injected. */
  nudgeInjected: boolean;
}

export interface LazinessEvent {
  event: 'laziness_classifier_fired' | 'laziness_nudge_fired';
  level: LazinessLevel;
  confidence: number;
  idleTurnCount: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Nudge messages (injected as system messages)
// ---------------------------------------------------------------------------

const NUDGE_MESSAGES: Record<LazinessLevel, string> = {
  active: '',
  mild_idle: 'You haven\'t taken any action in the last few turns. Consider using a tool to make progress on the task.',
  idle: 'You appear to be idle — no tool calls have been made recently. Take concrete action: read files, write code, run tests, or search for information. Don\'t just talk about what you\'ll do — do it.',
  very_idle: 'CRITICAL: You have been idle for multiple turns with no tool usage. The user expects you to actively work on their task, not just discuss it. Immediately use the appropriate tools to make progress.',
};

// ---------------------------------------------------------------------------
// LazinessNudge
// ---------------------------------------------------------------------------

/**
 * Detects lazy/passive agent behavior and injects proactivity nudges.
 *
 * Usage:
 * ```ts
 * const nudge = new LazinessNudge(hooks);
 * // after each turn:
 * const result = nudge.classify(toolCallsThisTurn, responseText);
 * if (result.nudgeInjected) {
 *   session.messages.push({ role: 'system', content: nudgeMessage });
 * }
 * ```
 */
export class LazinessNudge {
  private consecutiveIdleTurns = 0;
  private totalNudges = 0;
  private readonly hooks?: { emit(event: string, data: Record<string, unknown>): void } | null;

  constructor(hooks?: { emit(event: string, data: Record<string, unknown>): void } | null) {
    this.hooks = hooks ?? null;
    log.info({ cadence: LAZINESS_CADENCE, threshold: LAZINESS_THRESHOLD }, 'LazinessNudge initialised');
  }

  /**
   * Classify the agent's activity level after a turn.
   *
   * @param toolCallsCount  - Number of tool calls made this turn.
   * @param responseText     - The agent's text response this turn.
   * @returns LazinessClassification with level and optional nudge message.
   */
  classify(toolCallsCount: number, responseText: string): LazinessClassification {
    if (!LAZINESS_NUDGE_ENABLED) {
      return {
        level: 'active',
        confidence: 0,
        idleTurnCount: 0,
        evidence: ['Laziness nudge disabled'],
        nudgeInjected: false,
      };
    }

    const evidence: string[] = [];

    // Detect idle behavior
    const isIdle = toolCallsCount === 0;
    const isTextOnly = isIdle && responseText.length > 0;
    const isEmptyResponse = !isIdle && responseText.length === 0;

    if (isIdle) {
      this.consecutiveIdleTurns++;
      if (isTextOnly) {
        evidence.push(`Turn was text-only (no tool calls, ${responseText.length} chars of text)`);
      } else {
        evidence.push('Turn had no tool calls and no text response');
      }
    } else {
      this.consecutiveIdleTurns = 0;
      evidence.push(`${toolCallsCount} tool call(s) made this turn`);
    }

    if (isEmptyResponse) {
      evidence.push('Empty response with tool calls (unusual pattern)');
    }

    // Determine laziness level
    let level: LazinessLevel;
    let confidence: number;

    if (this.consecutiveIdleTurns === 0) {
      level = 'active';
      confidence = 0.9;
    } else if (this.consecutiveIdleTurns < LAZINESS_CADENCE) {
      level = 'mild_idle';
      confidence = 0.4 + (this.consecutiveIdleTurns / LAZINESS_CADENCE) * 0.3;
    } else if (this.consecutiveIdleTurns < LAZINESS_CADENCE * 2) {
      level = 'idle';
      confidence = 0.7 + (this.consecutiveIdleTurns - LAZINESS_CADENCE) / LAZINESS_CADENCE * 0.2;
    } else {
      level = 'very_idle';
      confidence = 0.9;
    }

    evidence.push(`Consecutive idle turns: ${this.consecutiveIdleTurns}`);

    // Determine if nudge should be injected
    let nudgeInjected = false;
    const nudgeMessage = NUDGE_MESSAGES[level];

    if (level !== 'active' && confidence >= LAZINESS_THRESHOLD && nudgeMessage) {
      nudgeInjected = true;
      this.totalNudges++;

      // Emit telemetry
      this._emitTelemetry('laziness_classifier_fired', { level, confidence, idleTurnCount: this.consecutiveIdleTurns });
      this._emitTelemetry('laziness_nudge_fired', { level, confidence, idleTurnCount: this.consecutiveIdleTurns });

      log.info(
        { level, confidence: confidence.toFixed(2), idleTurns: this.consecutiveIdleTurns },
        'Laziness nudge injected',
      );
    }

    return {
      level,
      confidence: Math.min(1, confidence),
      idleTurnCount: this.consecutiveIdleTurns,
      evidence,
      nudgeInjected,
    };
  }

  /**
   * Get the nudge message for the given laziness level.
   * Returns empty string for 'active' level.
   */
  getNudgeMessage(level: LazinessLevel): string {
    return NUDGE_MESSAGES[level] ?? '';
  }

  /** Reset idle counter (e.g., at the start of a new task). */
  reset(): void {
    this.consecutiveIdleTurns = 0;
    log.debug('LazinessNudge reset');
  }

  /** Get current statistics. */
  getStats(): { consecutiveIdleTurns: number; totalNudges: number } {
    return {
      consecutiveIdleTurns: this.consecutiveIdleTurns,
      totalNudges: this.totalNudges,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _emitTelemetry(event: string, data: { level: LazinessLevel; confidence: number; idleTurnCount: number }): void {
    if (this.hooks && typeof this.hooks.emit === 'function') {
      try {
        this.hooks.emit(event, {
          event,
          level: data.level,
          confidence: data.confidence,
          idleTurnCount: data.idleTurnCount,
          timestamp: new Date().toISOString(),
        } as unknown as Record<string, unknown>);
      } catch (err) {
        log.error({ err }, 'Failed to emit laziness telemetry');
      }
    }
  }
}