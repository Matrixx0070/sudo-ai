/**
 * @file doom-loop.ts
 * @description Doom Loop Detector v2 — Grok Build CLI parity.
 *
 * Detects when the agent is stuck in repetitive tool-call cycles.  Two modes:
 *   1. Cross-message — same tool+args pattern repeated across multiple turns.
 *   2. Single-message — loops detected within a single turn (delegates to LoopGuard).
 *
 * Thresholds match Grok Build CLI:
 *   - doomLoopThreshold = 4  → emit warning + inject nudge system message
 *   - doomLoopRoThreshold = 8 → force-terminate the agent loop
 *
 * Emits telemetry events: doom_loop_warning, doom_loop_terminated.
 * Configurable via SUDO_DOOM_LOOP_THRESHOLD and SUDO_DOOM_LOOP_RO_THRESHOLD env vars.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:doom-loop');

// ---------------------------------------------------------------------------
// Thresholds (Grok-parity defaults, env-overridable)
// ---------------------------------------------------------------------------

/** Warning threshold — number of repeated cycles before warning. */
export const DOOM_LOOP_THRESHOLD: number =
  Number(process.env['SUDO_DOOM_LOOP_THRESHOLD']) || 4;

/** Termination threshold — number of repeated cycles before force-quit. */
export const DOOM_LOOP_RO_THRESHOLD: number =
  Number(process.env['SUDO_DOOM_LOOP_RO_THRESHOLD']) || 8;

// ---------------------------------------------------------------------------
// Telemetry event types (exported for HookManager integration)
// ---------------------------------------------------------------------------

export interface DoomLoopWarningEvent {
  event: 'doom_loop_warning';
  toolName: string;
  argsSignature: string;
  cycleCount: number;
  threshold: number;
  timestamp: string;
}

export interface DoomLoopTerminatedEvent {
  event: 'doom_loop_terminated';
  toolName: string;
  argsSignature: string;
  cycleCount: number;
  roThreshold: number;
  timestamp: string;
}

export type DoomLoopEvent = DoomLoopWarningEvent | DoomLoopTerminatedEvent;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface DoomLoopResult {
  /** 'allow' = proceed, 'warn' = inject nudge, 'abort' = force-terminate. */
  action: 'allow' | 'warn' | 'abort';
  /** Human-readable explanation. */
  reason?: string;
  /** The telemetry event if action is warn or abort. */
  telemetryEvent?: DoomLoopEvent;
}

// ---------------------------------------------------------------------------
// Per-cycle fingerprint
// ---------------------------------------------------------------------------

interface CycleFingerprint {
  /** Tool name (e.g. "fs.read_file"). */
  toolName: string;
  /** Truncated hash of the args for matching. */
  argsSignature: string;
  /** Turn number when this was recorded. */
  turnNumber: number;
}

// ---------------------------------------------------------------------------
// DoomLoopDetector
// ---------------------------------------------------------------------------

/**
 * Persistent doom loop detector that tracks repetitive tool-call patterns
 * *across* turns (unlike LoopGuard which resets each turn).
 *
 * Call `recordCall()` on every tool call. Call `onNewTurn()` at the start of
 * each outer-loop turn.
 *
 * Usage:
 * ```ts
 * const detector = new DoomLoopDetector(hooks?);
 * // on each tool call:
 * const result = detector.recordCall('fs.read_file', { path: '/foo' }, turnNumber);
 * if (result.action === 'abort') { break; }
 * // on new turn:
 * detector.onNewTurn();
 * ```
 */
export class DoomLoopDetector {
  /** Tool calls grouped by "toolName:argsSignature" for cross-turn repeat detection. */
  private cycleMap = new Map<string, { count: number; lastTurn: number; toolName: string }>();

  /** All fingerprints in order (for sliding-window analysis). */
  private fingerprints: CycleFingerprint[] = [];

  /** Set of cycle keys that have already triggered a warning (avoid spam). */
  private warnedKeys = new Set<string>();

  /** Optional hook emitter for telemetry. */
  private readonly hooks?: { emit(event: string, data: Record<string, unknown>): void } | null;

  constructor(hooks?: { emit(event: string, data: Record<string, unknown>): void } | null) {
    this.hooks = hooks ?? null;
    log.info(
      { threshold: DOOM_LOOP_THRESHOLD, roThreshold: DOOM_LOOP_RO_THRESHOLD },
      'DoomLoopDetector initialised (Grok-parity)',
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a tool call and check for doom loops.
   *
   * @param toolName     - The tool being called.
   * @param args         - Tool arguments.
   * @param turnNumber  - Current outer-loop turn number.
   * @returns DoomLoopResult indicating whether to allow, warn, or abort.
   */
  recordCall(toolName: string, args: Record<string, unknown>, turnNumber: number): DoomLoopResult {
    const argsSignature = this._hashArgs(args);
    const key = `${toolName}:${argsSignature}`;

    // Store fingerprint
    this.fingerprints.push({ toolName, argsSignature, turnNumber });

    // Count across turns (cross-message detection)
    const existing = this.cycleMap.get(key);
    if (existing) {
      // Only count as a new cycle if it happened in a different turn
      if (existing.lastTurn !== turnNumber) {
        existing.count++;
        existing.lastTurn = turnNumber;
      }
    } else {
      this.cycleMap.set(key, { count: 1, lastTurn: turnNumber, toolName });
    }

    const entry = this.cycleMap.get(key)!;

    // Check termination threshold first
    if (entry.count >= DOOM_LOOP_RO_THRESHOLD) {
      const event: DoomLoopTerminatedEvent = {
        event: 'doom_loop_terminated',
        toolName,
        argsSignature,
        cycleCount: entry.count,
        roThreshold: DOOM_LOOP_RO_THRESHOLD,
        timestamp: new Date().toISOString(),
      };
      this._emitTelemetry(event);

      log.error(
        { toolName, cycleCount: entry.count, threshold: DOOM_LOOP_RO_THRESHOLD },
        'DOOM LOOP TERMINATED — force-quit',
      );

      return {
        action: 'abort',
        reason: `Doom loop detector: tool "${toolName}" repeated ${entry.count} times across turns (termination threshold: ${DOOM_LOOP_RO_THRESHOLD}). Force-terminating to prevent infinite loop.`,
        telemetryEvent: event,
      };
    }

    // Check warning threshold
    if (entry.count >= DOOM_LOOP_THRESHOLD && !this.warnedKeys.has(key)) {
      this.warnedKeys.add(key);
      const event: DoomLoopWarningEvent = {
        event: 'doom_loop_warning',
        toolName,
        argsSignature,
        cycleCount: entry.count,
        threshold: DOOM_LOOP_THRESHOLD,
        timestamp: new Date().toISOString(),
      };
      this._emitTelemetry(event);

      log.warn(
        { toolName, cycleCount: entry.count, threshold: DOOM_LOOP_THRESHOLD },
        'DOOM LOOP WARNING — repetitive cycle detected',
      );

      return {
        action: 'warn',
        reason: `Doom loop detector: tool "${toolName}" repeated ${entry.count} times across turns (warning threshold: ${DOOM_LOOP_THRESHOLD}). Consider a different approach.`,
        telemetryEvent: event,
      };
    }

    return { action: 'allow' };
  }

  /**
   * Call at the start of each new outer-loop turn.
   * Resets per-turn warning state but preserves cross-turn cycle counts.
   */
  onNewTurn(): void {
    // Per-turn state reset — warnedKeys persists across turns (key-level dedup)
    log.debug('DoomLoopDetector: new turn started');
  }

  /**
   * Full reset — clears all cross-turn history.
   * Use when starting a completely new session or task.
   */
  reset(): void {
    this.cycleMap.clear();
    this.fingerprints = [];
    this.warnedKeys.clear();
    log.debug('DoomLoopDetector fully reset');
  }

  /**
   * Get current cycle counts for diagnostics.
   */
  getCycleStats(): Array<{ toolName: string; argsSignature: string; count: number }> {
    return Array.from(this.cycleMap.entries()).map(([key, val]) => ({
      toolName: val.toolName,
      argsSignature: key.split(':')[1] ?? '',
      count: val.count,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this._canonicalize(v));
    }
    if (value !== null && typeof value === 'object') {
      const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
      const out: Record<string, unknown> = {};
      for (const k of sortedKeys) {
        out[k] = this._canonicalize((value as Record<string, unknown>)[k]);
      }
      return out;
    }
    return value;
  }

  private _hashArgs(args: Record<string, unknown>): string {
    try {
      // Deeply canonicalize (recursively sort keys) so that distinct nested
      // arguments produce distinct signatures. NOTE: passing the key array as
      // a JSON.stringify replacer is an allowlist that strips all nested
      // fields, collapsing different calls to one signature.
      const json = JSON.stringify(this._canonicalize(args));
      // Simple hash: first 12 chars of a cheap checksum
      let hash = 0;
      for (let i = 0; i < json.length; i++) {
        const ch = json.charCodeAt(i);
        hash = ((hash << 5) - hash + ch) | 0; // |0 keeps it 32-bit
      }
      return Math.abs(hash).toString(36).slice(0, 12);
    } catch {
      return 'unhashable';
    }
  }

  private _emitTelemetry(event: DoomLoopEvent): void {
    if (this.hooks && typeof this.hooks.emit === 'function') {
      try {
        this.hooks.emit(event.event, event as unknown as Record<string, unknown>);
      } catch (err) {
        log.error({ err }, 'Failed to emit doom loop telemetry');
      }
    }
  }
}