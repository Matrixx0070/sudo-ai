/**
 * @file security/discordance-detector.ts
 * @description Cross-stream discordance detector. Detects divergence from expected
 * agent behaviour across four independent signal streams: cadence, tool-graph
 * topology, outcome trend, and self-report text.
 *
 * All computation is synchronous and pure — no I/O, no DB, no network.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security:discordance-detector');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Rate-of-tool-call signal. */
export interface CadenceSignal {
  /** Number of tool calls observed in the last 60-second window. */
  callsInWindow: number;
  /** Expected (baseline) rate of calls per window, supplied by caller. */
  baselineCallsPerWindow: number;
}

/** Tool-usage topology signal. */
export interface ToolGraphSignal {
  /** Last N tool names in chronological order (oldest first). */
  recentToolNames: string[];
}

/** Outcome quality signal. */
export interface OutcomeTrendSignal {
  /** Last N outcome type strings, most-recent first. */
  recentOutcomeTypes: string[];
}

/** Self-generated text sentiment signal. */
export interface SelfReportSignal {
  /** Last agent-generated text snippet. May be empty string. */
  text: string;
}

/** All four signal streams bundled for a single detection call. */
export interface DiscordanceSignals {
  cadence: CadenceSignal;
  toolGraph: ToolGraphSignal;
  outcomeTrend: OutcomeTrendSignal;
  selfReport: SelfReportSignal;
}

/** Output from a single discordance detection pass. */
export interface DiscordanceResult {
  /** Traffic-light level. */
  level: 'normal' | 'elevated' | 'discordant';
  /** Composite score in range [0, 1]. */
  score: number;
  /** Names of scorer streams that were flagged as anomalous. */
  contributingSignals: string[];
  /** ISO-8601 timestamp of detection. */
  detectedAt: string;
}

/** Exported for future AlignmentAggregator wiring (Wave 6D: export only). */
export interface AlignmentAggregatorDiscordanceInput {
  discordanceScore: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScorerOutput {
  score: number;
  flagged: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISTRESS_MARKERS: readonly string[] = [
  'stuck',
  'cannot',
  'failed',
  'error',
  'blocked',
  'unable',
  'loop',
];

/**
 * Composite weights: cadence=0.30, toolGraph=0.20, outcomeTrend=0.35,
 * selfReport=0.15 (per spec section 2.3).
 */
const WEIGHT_CADENCE = 0.30;
const WEIGHT_TOOL_GRAPH = 0.20;
const WEIGHT_OUTCOME_TREND = 0.35;
const WEIGHT_SELF_REPORT = 0.15;

const THRESHOLD_DISCORDANT = 0.70;
const THRESHOLD_ELEVATED = 0.40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

// ---------------------------------------------------------------------------
// Individual scorers
// ---------------------------------------------------------------------------

/**
 * Cadence scorer.
 * Score = clamp(|calls/baseline − 1|, 0, 1).
 * Flagged when ratio > 2.0 or ratio < 0.25 (i.e. |ratio - 1| > 1 or ratio < 0.25).
 */
function scoreCadence(signal: CadenceSignal): ScorerOutput {
  const calls = signal.callsInWindow;
  const baseline = signal.baselineCallsPerWindow;

  if (!isFiniteNumber(calls) || !isFiniteNumber(baseline)) {
    log.warn({ calls, baseline }, 'scoreCadence: invalid inputs — neutralising to 0');
    return { score: 0, flagged: false };
  }

  if (baseline <= 0) {
    log.warn({ baseline }, 'scoreCadence: baseline <= 0 — neutralising to 0');
    return { score: 0, flagged: false };
  }

  const ratio = calls / baseline;
  const score = clamp(Math.abs(ratio - 1), 0, 1);
  const flagged = ratio > 2.0 || ratio < 0.25;

  return { score, flagged };
}

/**
 * Tool-graph topology scorer.
 * Score = (consecutive same-tool adjacencies) / (total items in array).
 * Flagged when score > 0.5.
 */
function scoreToolGraph(signal: ToolGraphSignal): ScorerOutput {
  const names = signal.recentToolNames;

  if (!Array.isArray(names) || names.length === 0) {
    return { score: 0, flagged: false };
  }

  let consecutivePairs = 0;
  for (let i = 1; i < names.length; i++) {
    if (names[i] === names[i - 1]) {
      consecutivePairs++;
    }
  }

  // Denominator is total items (not pairs), per spec "consecutive-same-tool-runs / total".
  const score = consecutivePairs / names.length;
  const flagged = score > 0.5;

  return { score, flagged };
}

/**
 * Outcome trend scorer.
 * Score = (error-type outcomes) / (total outcomes).
 * An outcome is "error" when its type string contains the substring 'error' (case-insensitive).
 * Flagged when error rate > 0.6.
 */
function scoreOutcomeTrend(signal: OutcomeTrendSignal): ScorerOutput {
  const outcomes = signal.recentOutcomeTypes;

  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return { score: 0, flagged: false };
  }

  const errorCount = outcomes.filter(
    (o) => typeof o === 'string' && o.toLowerCase().includes('error'),
  ).length;

  const score = errorCount / outcomes.length;
  const flagged = score > 0.6;

  return { score, flagged };
}

/**
 * Self-report distress scorer.
 * Score = (matched distress markers) / 7 (total markers).
 * Flagged when any marker is matched (score > 0).
 */
function scoreSelfReport(signal: SelfReportSignal): ScorerOutput {
  const text = signal.text;

  if (typeof text !== 'string' || text.length === 0) {
    return { score: 0, flagged: false };
  }

  const lowerText = text.toLowerCase();
  const matchedCount = DISTRESS_MARKERS.filter((marker) =>
    lowerText.includes(marker),
  ).length;

  const score = clamp(matchedCount / DISTRESS_MARKERS.length, 0, 1);
  const flagged = matchedCount > 0;

  return { score, flagged };
}

// ---------------------------------------------------------------------------
// Level classification
// ---------------------------------------------------------------------------

function classifyLevel(score: number): 'normal' | 'elevated' | 'discordant' {
  if (score >= THRESHOLD_DISCORDANT) return 'discordant';
  if (score >= THRESHOLD_ELEVATED) return 'elevated';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Re-anchor callback — module-level, set via setDiscordanceReAnchorCallback() from cli.ts
// ---------------------------------------------------------------------------

/**
 * Module-level re-anchor callback. Fired after a 'discordant' level is confirmed
 * (score >= 0.70). NOT fired on 'normal' or 'elevated' to limit noise.
 * Fail-open: if never set the callback is skipped silently.
 */
let _reAnchorCallback: (() => void) | undefined;

/**
 * Register a zero-argument re-anchor callback for post-discordance events.
 * Called from cli.ts after createReAnchorEmitter('post-discordance', ...) is built.
 * Pass undefined to clear (useful in tests afterEach).
 */
export function setDiscordanceReAnchorCallback(cb: (() => void) | undefined): void {
  _reAnchorCallback = cb;
  log.info({ event: 'discordance.reanchor.callback.set', hasCallback: cb !== undefined }, 'Discordance re-anchor callback updated');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect cross-stream discordance from four independent signal streams.
 *
 * Fail-open: any unhandled exception returns `{level:'normal', score:0, ...}`.
 */
export function detectDiscordance(signals: DiscordanceSignals): DiscordanceResult {
  const detectedAt = new Date().toISOString();

  try {
    const cadenceOut = scoreCadence(signals.cadence);
    const toolGraphOut = scoreToolGraph(signals.toolGraph);
    const outcomeTrendOut = scoreOutcomeTrend(signals.outcomeTrend);
    const selfReportOut = scoreSelfReport(signals.selfReport);

    const composite =
      cadenceOut.score * WEIGHT_CADENCE +
      toolGraphOut.score * WEIGHT_TOOL_GRAPH +
      outcomeTrendOut.score * WEIGHT_OUTCOME_TREND +
      selfReportOut.score * WEIGHT_SELF_REPORT;

    const score = clamp(composite, 0, 1);
    const level = classifyLevel(score);

    const contributingSignals: string[] = [];
    if (cadenceOut.flagged) contributingSignals.push('cadence');
    if (toolGraphOut.flagged) contributingSignals.push('toolGraph');
    if (outcomeTrendOut.flagged) contributingSignals.push('outcomeTrend');
    if (selfReportOut.flagged) contributingSignals.push('selfReport');

    log.debug(
      { level, score, contributingSignals },
      'detectDiscordance: result computed',
    );

    // Wave 7D: post-discordance re-anchor emission — fires only when score crosses
    // the 'discordant' threshold (>= 0.70). Does NOT fire on 'normal' or 'elevated'.
    if (level === 'discordant' && _reAnchorCallback !== undefined) {
      try {
        _reAnchorCallback();
      } catch {
        // fail-open — re-anchor emission is non-fatal
      }
    }

    return { level, score, contributingSignals, detectedAt };
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'detectDiscordance: unexpected exception — failing open');
    return {
      level: 'normal',
      score: 0,
      contributingSignals: [],
      detectedAt,
    };
  }
}
