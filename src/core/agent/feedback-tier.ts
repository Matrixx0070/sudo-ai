/**
 * Feedback Tier System — tracks sustained user engagement and adapts
 * agent behavior accordingly.
 *
 * Mirrors Grok Build CLI's `signals.json` pattern with 3 feedback tiers:
 *
 * - **Sustained** (10+ turns): High engagement — agent is more proactive,
 *   uses richer explanations, and auto-approves low-risk operations.
 * - **Complex** (15+ turns + errors): Deep engagement through difficulty —
 *   agent provides more detailed error analysis, suggests alternatives,
 *   and enables best-of-N by default.
 * - **Friction** (cancellation signals): User is frustrated — agent
 *   simplifies responses, asks clarifying questions, and reduces tool
 *   complexity to rebuild trust.
 *
 * Signals tracked per session:
 *  - turnCount, toolCallCount, doomLoopDetections
 *  - cancellationCount (user cancelled tool execution)
 *  - errorCount (tool errors encountered)
 *  - avgTimeToFirstTokenMs (responsiveness)
 *  - goalCompletionRate (tasks actually completed)
 *
 * Environment overrides:
 *  - SUDO_FEEDBACK_TIER_SUSTAINED_TURNS (default: 10)
 *  - SUDO_FEEDBACK_TIER_COMPLEX_TURNS (default: 15)
 *  - SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS (default: 3)
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:feedback-tier');

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export interface SessionSignals {
  /** Number of user turns in this session. */
  turnCount: number;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Number of doom-loop detections. */
  doomLoopDetections: number;
  /** Number of tool cancellations by the user. */
  cancellationCount: number;
  /** Number of tool errors encountered. */
  errorCount: number;
  /** Average ms to first token across all brain calls. */
  avgTimeToFirstTokenMs: number;
  /** Fraction of goals that were completed (0..1). */
  goalCompletionRate: number;
  /** Timestamp of the first signal. */
  startedAt: string;
  /** Timestamp of the most recent signal update. */
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Feedback Tier enum
// ---------------------------------------------------------------------------

export type FeedbackTier = 'none' | 'sustained' | 'complex' | 'friction';

export interface FeedbackTierAssessment {
  /** Current tier. */
  tier: FeedbackTier;
  /** Human-readable reason for the tier assignment. */
  reason: string;
  /** Suggested behavior adjustments. */
  adjustments: FeedbackAdjustments;
  /** Current session signals snapshot. */
  signals: SessionSignals;
}

export interface FeedbackAdjustments {
  /** How proactive the agent should be (0 = reactive, 1 = very proactive). */
  proactivity: number;
  /** Response verbosity level (0 = minimal, 1 = detailed). */
  verbosity: number;
  /** Whether auto-approve is recommended for low-risk operations. */
  autoApproveLowRisk: boolean;
  /** Whether best-of-N should be enabled by default. */
  enableBestOfN: boolean;
  /** Whether the agent should ask clarifying questions. */
  askClarifyingQuestions: boolean;
  /** Temperature adjustment (-0.3 to +0.3). */
  temperatureDelta: number;
  /** Suggested system prompt addition. */
  promptAddition: string;
}

// ---------------------------------------------------------------------------
// Thresholds (env-overridable)
// ---------------------------------------------------------------------------

function getThreshold(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

const SUSTAINED_TURNS = () => getThreshold('SUDO_FEEDBACK_TIER_SUSTAINED_TURNS', 10);
const COMPLEX_TURNS = () => getThreshold('SUDO_FEEDBACK_TIER_COMPLEX_TURNS', 15);
const FRICTION_CANCELLATIONS = () => getThreshold('SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS', 3);

// ---------------------------------------------------------------------------
// FeedbackTierManager
// ---------------------------------------------------------------------------

/**
 * Tracks session-level signals and computes the current feedback tier.
 * The tier drives behavioral adjustments in the agent loop.
 */
export class FeedbackTierManager {
  private signals: SessionSignals;

  constructor() {
    const now = new Date().toISOString();
    this.signals = {
      turnCount: 0,
      toolCallCount: 0,
      doomLoopDetections: 0,
      cancellationCount: 0,
      errorCount: 0,
      avgTimeToFirstTokenMs: 0,
      goalCompletionRate: 0,
      startedAt: now,
      lastUpdatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Signal recording
  // -------------------------------------------------------------------------

  /** Record a user turn. */
  recordTurn(): void {
    this.signals.turnCount++;
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  /** Record a tool call. */
  recordToolCall(): void {
    this.signals.toolCallCount++;
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  /** Record a doom loop detection. */
  recordDoomLoop(): void {
    this.signals.doomLoopDetections++;
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  /** Record a user cancellation. */
  recordCancellation(): void {
    this.signals.cancellationCount++;
    this.signals.lastUpdatedAt = new Date().toISOString();
    log.debug(
      { cancellationCount: this.signals.cancellationCount },
      'Cancellation recorded — friction signal',
    );
  }

  /** Record a tool error. */
  recordError(): void {
    this.signals.errorCount++;
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  /** Update the average time to first token. */
  recordTimeToFirstToken(ms: number): void {
    // Running average
    if (this.signals.avgTimeToFirstTokenMs === 0) {
      this.signals.avgTimeToFirstTokenMs = ms;
    } else {
      this.signals.avgTimeToFirstTokenMs =
        (this.signals.avgTimeToFirstTokenMs * 0.8) + (ms * 0.2);
    }
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  /** Update the goal completion rate. */
  recordGoalCompletionRate(rate: number): void {
    this.signals.goalCompletionRate = Math.max(0, Math.min(1, rate));
    this.signals.lastUpdatedAt = new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Tier assessment
  // -------------------------------------------------------------------------

  /**
   * Compute the current feedback tier and behavioral adjustments.
   *
   * Tier logic:
   *  1. If cancellations >= threshold → FRICTION (regardless of other signals)
   *  2. If turns >= complex threshold AND (errors > 0 OR doom loops > 0) → COMPLEX
   *  3. If turns >= sustained threshold → SUSTAINED
   *  4. Otherwise → NONE
   */
  assess(): FeedbackTierAssessment {
    const s = this.signals;
    let tier: FeedbackTier = 'none';
    let reason = '';

    // Friction tier takes priority — user is actively cancelling
    if (s.cancellationCount >= FRICTION_CANCELLATIONS()) {
      tier = 'friction';
      reason = `${s.cancellationCount} cancellations detected — user may be frustrated`;
    }
    // Complex tier — deep engagement through difficulty
    else if (s.turnCount >= COMPLEX_TURNS() && (s.errorCount > 0 || s.doomLoopDetections > 0)) {
      tier = 'complex';
      reason = `${s.turnCount} turns with ${s.errorCount} errors and ${s.doomLoopDetections} doom-loop detections`;
    }
    // Sustained tier — healthy ongoing engagement
    else if (s.turnCount >= SUSTAINED_TURNS()) {
      tier = 'sustained';
      reason = `${s.turnCount} sustained turns — high engagement`;
    }
    // Default — no tier
    else {
      tier = 'none';
      reason = `Only ${s.turnCount} turns — insufficient data for tier classification`;
    }

    const adjustments = this._computeAdjustments(tier);

    log.debug({ tier, reason, turnCount: s.turnCount }, 'Feedback tier assessed');

    return { tier, reason, adjustments, signals: { ...this.signals } };
  }

  /** Get the current signals snapshot (read-only copy). */
  getSignals(): SessionSignals {
    return { ...this.signals };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _computeAdjustments(tier: FeedbackTier): FeedbackAdjustments {
    switch (tier) {
      case 'sustained':
        return {
          proactivity: 0.7,
          verbosity: 0.6,
          autoApproveLowRisk: true,
          enableBestOfN: false,
          askClarifyingQuestions: false,
          temperatureDelta: 0.05,
          promptAddition: '[FEEDBACK: sustained engagement — be proactive, take initiative on low-risk actions]',
        };

      case 'complex':
        return {
          proactivity: 0.9,
          verbosity: 0.8,
          autoApproveLowRisk: true,
          enableBestOfN: true,
          askClarifyingQuestions: false,
          temperatureDelta: 0.1,
          promptAddition: '[FEEDBACK: complex engagement — provide detailed analysis, use best-of-N for important decisions]',
        };

      case 'friction':
        return {
          proactivity: 0.3,
          verbosity: 0.3,
          autoApproveLowRisk: false,
          enableBestOfN: false,
          askClarifyingQuestions: true,
          temperatureDelta: -0.1,
          promptAddition: '[FEEDBACK: friction detected — simplify responses, ask clarifying questions, reduce tool complexity]',
        };

      case 'none':
      default:
        return {
          proactivity: 0.5,
          verbosity: 0.5,
          autoApproveLowRisk: false,
          enableBestOfN: false,
          askClarifyingQuestions: false,
          temperatureDelta: 0,
          promptAddition: '',
        };
    }
  }
}