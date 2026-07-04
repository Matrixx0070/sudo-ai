/**
 * @file session-signals.ts
 * @description Unified per-session metrics / signals collector for SUDO-AI.
 *
 * Mirrors the Grok Build CLI `signals.json` pattern: a single object that
 * accumulates telemetry throughout a session so that downstream consumers
 * (trace analysis, policy engine, feedback tiers) can reason about session
 * health and outcome in a structured way.
 *
 * Usage:
 * ```ts
 * import { SessionSignalsCollector, formatSignalsAsMarkdown, persistSignals } from '../core/learning/session-signals.js';
 *
 * const signals = new SessionSignalsCollector({ model: 'claude-opus-4' });
 * signals.recordTurn();
 * signals.recordTimeToFirstToken(120);
 * signals.recordInterTokenLatency(15);
 * signals.sampleMemory();
 * signals.endSession();
 * persistSignals('sess-abc123', signals.getSnapshot());
 * ```
 */

import { mkdirSync, existsSync } from 'fs';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of all signals collected for a session.
 * Used for serialisation, persistence, and downstream analysis.
 */
export interface SessionSignals {
  /** Total turns (user messages) in the session */
  turnCount: number;
  /** Total tool invocations */
  toolCallCount: number;
  /** Number of doom-loop detections */
  doomLoopDetections: number;
  /** Exponential moving average of time-to-first-token (ms) */
  avgTimeToFirstTokenMs: number;
  /** Peak RSS in bytes sampled from `process.memoryUsage()` */
  peakRssBytes: number;
  /** Inter-token latency p50 (ms) */
  itlP50Ms: number;
  /** Inter-token latency p95 (ms) */
  itlP95Ms: number;
  /** Inter-token latency p99 (ms) */
  itlP99Ms: number;
  /** Total errors encountered */
  errorCount: number;
  /** Total user-initiated cancellations */
  cancellationCount: number;
  /** Classification from GoalClassifier (e.g. "code_gen", "research") */
  goalClassificationType: string;
  /** Verdict from GoalStopDetector (e.g. "complete", "abandoned") */
  goalCompletionVerdict: string;
  /** Tier from FeedbackTierManager (e.g. "positive", "negative") */
  feedbackTier: string;
  /** Whether Zero-Downtime Recovery was active */
  zdrActive: boolean;
  /** ISO-8601 session start time */
  startTime: string;
  /** ISO-8601 session end time, null while session is live */
  endTime: string | null;
  /** Wall-clock duration in ms */
  totalDurationMs: number;
  /** Model identifier (e.g. "claude-opus-4") */
  modelUsed: string;
  /** Token usage broken down by input / output */
  tokensUsed: { input: number; output: number };
}

/** Configuration for a new SessionSignalsCollector. */
export interface SessionSignalsCollectorOptions {
  /** Model identifier; defaults to "unknown" */
  model?: string;
  /** Override start time (ISO string); defaults to now */
  startTime?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of inter-token latency samples retained for percentile math. */
const ITL_WINDOW = 100;

/** Smoothing factor for the exponential moving average of TTFT. */
const EMA_ALPHA = 0.3;

/** Default root directory for persisted signal files. */
const DEFAULT_DATA_ROOT = 'data';

// ---------------------------------------------------------------------------
// SessionSignalsCollector
// ---------------------------------------------------------------------------

/**
 * Collects and aggregates per-session metric signals.
 *
 * The collector is mutable: call `record*` / `set*` methods as events occur
 * during a session, then call `endSession()` and `getSnapshot()` or
 * `toJSON()` to freeze and serialise the results.
 */
export class SessionSignalsCollector {
  // -- Counters ---------------------------------------------------------------
  private _turnCount = 0;
  private _toolCallCount = 0;
  private _doomLoopDetections = 0;
  private _errorCount = 0;
  private _cancellationCount = 0;

  // -- Averages / samples ----------------------------------------------------
  private _avgTimeToFirstTokenMs = 0;
  private _hasTTFT = false;
  private _peakRssBytes = 0;

  /** Sorted ring-buffer of the last `ITL_WINDOW` inter-token latency samples. */
  private _itlSamples: number[] = [];

  // -- Classification / verdict fields ---------------------------------------
  private _goalClassificationType = '';
  private _goalCompletionVerdict = '';
  private _feedbackTier = '';
  private _zdrActive = false;
  private _modelUsed: string;

  // -- Timing ----------------------------------------------------------------
  private _startTime: string;
  private _endTime: string | null = null;
  private _totalDurationMs = 0;
  private _startEpochMs: number;

  // -- Token usage -----------------------------------------------------------
  private _tokensInput = 0;
  private _tokensOutput = 0;

  constructor(opts: SessionSignalsCollectorOptions = {}) {
    this._modelUsed = opts.model ?? 'unknown';
    this._startTime = opts.startTime ?? new Date().toISOString();
    this._startEpochMs = Date.now();
    this._peakRssBytes = this._sampleRss();
  }

  // -- Recording methods ------------------------------------------------------

  /** Increment the turn counter. */
  recordTurn(): void {
    this._turnCount++;
  }

  /** Increment the tool-call counter. */
  recordToolCall(): void {
    this._toolCallCount++;
  }

  /** Increment the doom-loop detection counter. */
  recordDoomLoop(): void {
    this._doomLoopDetections++;
  }

  /**
   * Update the exponential moving average of time-to-first-token.
   *
   * The first sample seeds the EMA directly; subsequent samples are
   * blended with weight `EMA_ALPHA`.
   */
  recordTimeToFirstToken(ms: number): void {
    if (!this._hasTTFT) {
      this._avgTimeToFirstTokenMs = ms;
      this._hasTTFT = true;
    } else {
      this._avgTimeToFirstTokenMs =
        EMA_ALPHA * ms + (1 - EMA_ALPHA) * this._avgTimeToFirstTokenMs;
    }
  }

  /**
   * Record a single inter-token latency sample.
   *
   * Maintains a sorted sliding window of the last `ITL_WINDOW` samples
   * for percentile computation.
   */
  recordInterTokenLatency(ms: number): void {
    // Push to end (FIFO order for ring buffer eviction)
    this._itlSamples.push(ms);

    // Evict oldest (first inserted) when window is full
    if (this._itlSamples.length > ITL_WINDOW) {
      this._itlSamples.shift();
    }
  }

  /** Increment the error counter. */
  recordError(): void {
    this._errorCount++;
  }

  /** Increment the cancellation counter. */
  recordCancellation(): void {
    this._cancellationCount++;
  }

  /** Accumulate token usage. Values are additive across calls. */
  recordTokenUsage(input: number, output: number): void {
    this._tokensInput += input;
    this._tokensOutput += output;
  }

  // -- Setter methods --------------------------------------------------------

  /** Set the goal classification type (from GoalClassifier). */
  setGoalClassification(type: string): void {
    this._goalClassificationType = type;
  }

  /** Set the goal completion verdict (from GoalStopDetector). */
  setGoalCompletionVerdict(verdict: string): void {
    this._goalCompletionVerdict = verdict;
  }

  /** Set the feedback tier (from FeedbackTierManager). */
  setFeedbackTier(tier: string): void {
    this._feedbackTier = tier;
  }

  /** Set whether Zero-Downtime Recovery is active. */
  setZDR(active: boolean): void {
    this._zdrActive = active;
  }

  /** Set the model identifier. */
  setModel(model: string): void {
    this._modelUsed = model;
  }

  // -- Sampling / lifecycle --------------------------------------------------

  /**
   * Sample current process RSS and track the peak.
   * Safe to call periodically (e.g. every 5 s) from a timer.
   */
  sampleMemory(): void {
    const rss = this._sampleRss();
    if (rss > this._peakRssBytes) {
      this._peakRssBytes = rss;
    }
  }

  /**
   * End the session: record end time and compute total wall-clock duration.
   * Idempotent -- subsequent calls are no-ops.
   */
  endSession(): void {
    if (this._endTime !== null) return;
    this._endTime = new Date().toISOString();
    this._totalDurationMs = Date.now() - this._startEpochMs;
  }

  // -- Read methods ----------------------------------------------------------

  /**
   * Return a deep copy of the current signal state.
   * Mutations to the returned object do not affect the collector.
   */
  getSnapshot(): SessionSignals {
    const { p50, p95, p99 } = this._computeItlPercentiles();
    return {
      turnCount: this._turnCount,
      toolCallCount: this._toolCallCount,
      doomLoopDetections: this._doomLoopDetections,
      avgTimeToFirstTokenMs: Math.round(this._avgTimeToFirstTokenMs * 100) / 100,
      peakRssBytes: this._peakRssBytes,
      itlP50Ms: p50,
      itlP95Ms: p95,
      itlP99Ms: p99,
      errorCount: this._errorCount,
      cancellationCount: this._cancellationCount,
      goalClassificationType: this._goalClassificationType,
      goalCompletionVerdict: this._goalCompletionVerdict,
      feedbackTier: this._feedbackTier,
      zdrActive: this._zdrActive,
      startTime: this._startTime,
      endTime: this._endTime,
      totalDurationMs: this._totalDurationMs,
      modelUsed: this._modelUsed,
      tokensUsed: { input: this._tokensInput, output: this._tokensOutput },
    };
  }

  /** Serialise the current snapshot as pretty-printed JSON. */
  toJSON(): string {
    return JSON.stringify(this.getSnapshot(), null, 2);
  }

  // -- Private helpers -------------------------------------------------------

  /** Read current RSS from `process.memoryUsage()`. Returns 0 outside Node. */
  private _sampleRss(): number {
    try {
      // eslint-disable-next-line no-restricted-globals
      if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
        return process.memoryUsage().rss;
      }
    } catch {
      // Bundler / browser fallback
    }
    return 0;
  }

  /** Compute p50 / p95 / p99 from the ITL sample window. Sorts a copy first. */
  private _computeItlPercentiles(): { p50: number; p95: number; p99: number } {
    const n = this._itlSamples.length;
    if (n === 0) return { p50: 0, p95: 0, p99: 0 };

    // Sort a copy for percentile computation (original stays in insertion order)
    const sorted = [...this._itlSamples].sort((a, b) => a - b);

    const rank = (p: number): number => {
      const idx = Math.ceil((p / 100) * n) - 1;
      return sorted[Math.max(0, Math.min(idx, n - 1))];
    };

    return {
      p50: Math.round(rank(50) * 100) / 100,
      p95: Math.round(rank(95) * 100) / 100,
      p99: Math.round(rank(99) * 100) / 100,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pretty-print a SessionSignals snapshot as a human-readable Markdown table.
 * Suitable for logging or inclusion in session reports.
 */
export function formatSignalsAsMarkdown(signals: SessionSignals): string {
  const lines: string[] = [
    '# Session Signals',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Turn Count | ${signals.turnCount} |`,
    `| Tool Call Count | ${signals.toolCallCount} |`,
    `| Doom Loop Detections | ${signals.doomLoopDetections} |`,
    `| Avg TTFT (ms) | ${signals.avgTimeToFirstTokenMs} |`,
    `| Peak RSS (bytes) | ${signals.peakRssBytes} |`,
    `| ITL p50 (ms) | ${signals.itlP50Ms} |`,
    `| ITL p95 (ms) | ${signals.itlP95Ms} |`,
    `| ITL p99 (ms) | ${signals.itlP99Ms} |`,
    `| Error Count | ${signals.errorCount} |`,
    `| Cancellation Count | ${signals.cancellationCount} |`,
    `| Goal Classification | ${signals.goalClassificationType || '—'} |`,
    `| Goal Completion Verdict | ${signals.goalCompletionVerdict || '—'} |`,
    `| Feedback Tier | ${signals.feedbackTier || '—'} |`,
    `| ZDR Active | ${signals.zdrActive} |`,
    `| Start Time | ${signals.startTime} |`,
    `| End Time | ${signals.endTime ?? '—'} |`,
    `| Duration (ms) | ${signals.totalDurationMs} |`,
    `| Model | ${signals.modelUsed} |`,
    `| Tokens In | ${signals.tokensUsed.input} |`,
    `| Tokens Out | ${signals.tokensUsed.output} |`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Persist a SessionSignals snapshot to `data/signals/{sessionId}.json`.
 *
 * Creates the `data/signals` directory tree if it does not exist.
 *
 * @param sessionId - Unique session identifier used as the filename.
 * @param signals  - The snapshot to persist.
 * @param dataRoot - Optional override for the data root directory
 *                   (defaults to `"data"` relative to cwd).
 */
export function persistSignals(
  sessionId: string,
  signals: SessionSignals,
  dataRoot: string = DEFAULT_DATA_ROOT,
): void {
  const dir = join(dataRoot, 'signals');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${sessionId}.json`);
  writeFileAtomic(filePath, JSON.stringify(signals, null, 2));
}