/**
 * @file stuck-detector.ts
 * @description Result-aware stuck detection (OpenHands-inspired).
 *
 * Fills the gap left by LoopGuard and DoomLoopDetector: both key on
 * tool name + arguments, so an agent that retries the SAME failing
 * operation with DIFFERENT args (or whose identical call keeps failing
 * across iterations) goes undetected. This detector keys on the tool
 * result instead — it tracks consecutive identical *error* results from
 * the same tool and warns/aborts when the streak crosses a threshold.
 *
 * Scope is deliberately conservative for the first slice:
 *   - Strictly consecutive: any other result (success, different error,
 *     different tool) resets the streak. Interleaved stuck patterns are
 *     a future extension.
 *   - Wait/poll-style tools are exempt (REPEAT_EXEMPT_TOOLS) — polling
 *     legitimately produces repeated identical observations.
 *
 * Opt-in and fail-open: disabled unless SUDO_STUCK_DETECTOR=1.
 * Thresholds via SUDO_STUCK_DETECTOR_WARN_THRESHOLD (default 3) and
 * SUDO_STUCK_DETECTOR_ABORT_THRESHOLD (default 5).
 */

import { createLogger } from '../shared/logger.js';
import { REPEAT_EXEMPT_TOOLS } from './loop-guard.js';

const log = createLogger('agent:stuck-detector');

export interface StuckDetectorOptions {
  /** Override env-derived enablement (tests). */
  enabled?: boolean;
  /** Consecutive identical errors before injecting a warning. */
  warnThreshold?: number;
  /** Consecutive identical errors before aborting the loop. */
  abortThreshold?: number;
}

export interface StuckDetectorResult {
  /** 'allow' = proceed, 'warn' = inject nudge, 'abort' = terminate loop. */
  action: 'allow' | 'warn' | 'abort';
  /** Human-readable explanation. */
  reason?: string;
}

/** Max chars of normalized error content used for the signature. */
const SIGNATURE_CONTENT_LENGTH = 300;

function envPositiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class StuckDetector {
  readonly enabled: boolean;
  private readonly warnThreshold: number;
  private readonly abortThreshold: number;

  private streakSignature: string | null = null;
  private streakToolName: string | null = null;
  private streakCount = 0;
  /**
   * Signatures already warned about. Intentional: once warned about a
   * signature within a run there is no re-warn, even if the streak breaks
   * and rebuilds — reset() clears this for the next run.
   */
  private warnedSignatures = new Set<string>();

  constructor(opts: StuckDetectorOptions = {}) {
    this.enabled = opts.enabled ?? process.env['SUDO_STUCK_DETECTOR'] === '1';
    // Positive integers only; '0', negatives, and malformed values fall back
    // to defaults (matches the repo's numeric-flag convention).
    this.warnThreshold = opts.warnThreshold ?? envPositiveInt('SUDO_STUCK_DETECTOR_WARN_THRESHOLD', 3);
    this.abortThreshold = opts.abortThreshold ?? envPositiveInt('SUDO_STUCK_DETECTOR_ABORT_THRESHOLD', 5);
    if (this.enabled) {
      log.info(
        { warnThreshold: this.warnThreshold, abortThreshold: this.abortThreshold },
        'StuckDetector enabled (result-aware repeated-error detection)',
      );
    }
  }

  /**
   * Record a tool result and check for a stuck streak.
   *
   * @param toolName      - The tool that produced the result.
   * @param resultContent - The result content as fed back to the model.
   * @param isError       - Whether the result classifies as an error.
   */
  recordResult(toolName: string, resultContent: string, isError: boolean): StuckDetectorResult {
    if (!this.enabled) return { action: 'allow' };

    if (!isError || REPEAT_EXEMPT_TOOLS.has(toolName)) {
      this._resetStreak();
      return { action: 'allow' };
    }

    const signature = `${toolName}:${this._hashContent(this._normalize(resultContent))}`;
    if (signature === this.streakSignature) {
      this.streakCount++;
    } else {
      this.streakSignature = signature;
      this.streakToolName = toolName;
      this.streakCount = 1;
    }

    if (this.streakCount >= this.abortThreshold) {
      const streak = this.streakCount;
      log.error(
        { toolName, streak, threshold: this.abortThreshold },
        'STUCK DETECTED — identical error streak hit abort threshold',
      );
      // Leave the detector in a clean state so a caller that keeps recording
      // after an abort re-accumulates from 1 instead of re-aborting instantly.
      this._resetStreak();
      return {
        action: 'abort',
        reason: `Stuck detector: tool "${toolName}" returned the same error ${streak} consecutive times (abort threshold: ${this.abortThreshold}). Terminating to prevent a no-progress loop.`,
      };
    }

    if (this.streakCount >= this.warnThreshold && !this.warnedSignatures.has(signature)) {
      this.warnedSignatures.add(signature);
      log.warn(
        { toolName, streak: this.streakCount, threshold: this.warnThreshold },
        'Stuck warning — identical error streak',
      );
      return {
        action: 'warn',
        reason: `Stuck detector: tool "${toolName}" returned the same error ${this.streakCount} consecutive times. The current approach is not working — change strategy instead of retrying.`,
      };
    }

    return { action: 'allow' };
  }

  /** Full reset — call at the start of each agent run. */
  reset(): void {
    this._resetStreak();
    this.warnedSignatures.clear();
  }

  /** Current streak for diagnostics/tests. */
  getStreak(): { toolName: string | null; count: number } {
    return { toolName: this.streakToolName, count: this.streakCount };
  }

  private _resetStreak(): void {
    this.streakSignature = null;
    this.streakToolName = null;
    this.streakCount = 0;
  }

  /** Collapse whitespace and truncate so volatile padding does not split signatures. */
  private _normalize(content: string): string {
    return content.trim().replace(/\s+/g, ' ').slice(0, SIGNATURE_CONTENT_LENGTH);
  }

  private _hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const ch = content.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return Math.abs(hash).toString(36).slice(0, 12);
  }
}
