/**
 * @file loop-guard.ts
 * @description LoopGuard — detects and breaks tool-call loops inside AgentLoop.
 *
 * Three independent detectors run on every tool call within a single turn:
 *   1. Repeat detector   — same tool + same args called too many times.
 *   2. Ping-pong detector— alternating between exactly two tools too many times.
 *   3. Budget detector   — total tool calls in one turn exceeds limits.
 *
 * LoopGuardResult.action:
 *   'allow'  — proceed normally.
 *   'warn'   — inject a warning system message but continue.
 *   'abort'  — force-break the inner loop immediately.
 */

import { createLogger } from '../shared/index.js';
import { contentHash } from '../shared/index.js';
import {
  DEFAULT_SUPPRESS_HITS,
  getGlobalLoopSignatureStore,
  pingPongSignature,
  repeatSignature,
  type LoopSignatureStore,
} from './loop-signature-store.js';

const log = createLogger('agent:loop-guard');

// ---------------------------------------------------------------------------
// Thresholds (exported so tests can verify them)
// ---------------------------------------------------------------------------

export const REPEAT_WARN_THRESHOLD = 10;
export const REPEAT_ABORT_THRESHOLD = 20;
export const PINGPONG_ABORT_THRESHOLD = 15; // tightened for Ollama models, but allows real retry loops
export const BUDGET_WARN_THRESHOLD = 500;
export const BUDGET_ABORT_THRESHOLD = 1000;

/**
 * Tools legitimately called many times with identical args — exempt from repeat detection.
 * e.g. browser.screenshot is called after every browser action to confirm state.
 */
export const REPEAT_EXEMPT_TOOLS = new Set([
  'browser.screenshot',
  'browser.snapshot',
  'browser.tabs',
  'meta.health-check',
  'system.read-file',
  'system.list-dir',
]);

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/** Result returned by LoopGuard.recordCall(). */
export interface LoopGuardResult {
  action: 'allow' | 'warn' | 'abort';
  /** Human-readable explanation when action is 'warn' or 'abort'. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal tracking structures
// ---------------------------------------------------------------------------

interface CallRecord {
  toolName: string;
  argsHash: string;
}

// ---------------------------------------------------------------------------
// LoopGuard
// ---------------------------------------------------------------------------

/**
 * Stateful loop detector scoped to a single agent turn.
 * Call reset() at the start of each new outer-loop turn.
 *
 * Optional cross-session learning: pass a LoopSignatureStore and any
 * signature that has fired in `suppressHits` prior sessions will abort on
 * its very first identical call instead of waiting for the in-turn
 * threshold. Same store gets the signature persisted whenever an abort
 * actually fires here, so the learning is cumulative.
 */
export class LoopGuard {
  /** All tool calls made in this turn (in order). */
  private history: CallRecord[] = [];

  /** Map of "toolName:argsHash" → call count. */
  private repeatCounts = new Map<string, number>();

  /** Total calls in this turn. */
  private totalCalls = 0;

  constructor(
    private readonly signatureStore?: LoopSignatureStore,
    private readonly suppressHits: number = DEFAULT_SUPPRESS_HITS,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a tool call and check all detectors.
   *
   * @param toolName - Name of the tool being invoked.
   * @param args     - Arguments passed to the tool.
   * @returns LoopGuardResult indicating whether to allow, warn, or abort.
   */
  recordCall(toolName: string, args: Record<string, unknown>): LoopGuardResult {
    if (!toolName || typeof toolName !== 'string') {
      log.warn({ toolName }, 'LoopGuard: invalid toolName — skipping check');
      return { action: 'allow' };
    }

    const argsHash = this._hashArgs(args);
    const record: CallRecord = { toolName, argsHash };

    this.history.push(record);
    this.totalCalls++;

    // Fast-suppress check: a known-bad signature short-circuits the
    // in-turn thresholds. Saves the agent from re-discovering loops it has
    // already aborted on in prior sessions. Skipped when no store wired
    // (legacy callers / unit tests) — behaviour is byte-identical there.
    const fast = this._checkFastSuppress(toolName, argsHash);
    if (fast.action === 'abort') {
      log.error({ toolName, totalCalls: this.totalCalls, reason: fast.reason }, 'LoopGuard ABORT (fast-suppress)');
      this._persistAbortSignature(toolName, argsHash);
      return fast;
    }

    // Run all three detectors, escalate to highest severity result
    const results: LoopGuardResult[] = [
      this._checkRepeat(toolName, argsHash),
      this._checkPingPong(),
      this._checkBudget(),
    ];

    // Priority: abort > warn > allow
    const abort = results.find((r) => r.action === 'abort');
    if (abort) {
      log.error({ toolName, totalCalls: this.totalCalls, reason: abort.reason }, 'LoopGuard ABORT');
      this._persistAbortSignature(toolName, argsHash);
      return abort;
    }

    const warn = results.find((r) => r.action === 'warn');
    if (warn) {
      log.warn({ toolName, totalCalls: this.totalCalls, reason: warn.reason }, 'LoopGuard WARN');
      return warn;
    }

    return { action: 'allow' };
  }

  /**
   * Reset all state for a new turn.
   * Must be called at the start of every outer-loop iteration.
   */
  reset(): void {
    this.history = [];
    this.repeatCounts.clear();
    this.totalCalls = 0;
    log.debug({}, 'LoopGuard reset for new turn');
  }

  /** Current total tool calls in this turn (for inspection). */
  get callCount(): number {
    return this.totalCalls;
  }

  // -------------------------------------------------------------------------
  // Detectors
  // -------------------------------------------------------------------------

  /** Detector 1: same tool + same args called too many times. */
  private _checkRepeat(toolName: string, argsHash: string): LoopGuardResult {
    // Exempt tools that are legitimately called many times with the same args.
    if (REPEAT_EXEMPT_TOOLS.has(toolName)) return { action: 'allow' };

    const key = `${toolName}:${argsHash}`;
    const count = (this.repeatCounts.get(key) ?? 0) + 1;
    this.repeatCounts.set(key, count);

    if (count >= REPEAT_ABORT_THRESHOLD) {
      return {
        action: 'abort',
        reason: `Repeat detector: tool "${toolName}" called with identical args ${count} times — aborting to prevent infinite loop.`,
      };
    }

    if (count >= REPEAT_WARN_THRESHOLD) {
      return {
        action: 'warn',
        reason: `Repeat detector: tool "${toolName}" called with identical args ${count} times. Consider breaking the loop.`,
      };
    }

    return { action: 'allow' };
  }

  /** Detector 2: alternating between exactly two tools WITH identical args for too many cycles. */
  private _checkPingPong(): LoopGuardResult {
    const h = this.history;
    const threshold = PINGPONG_ABORT_THRESHOLD;
    // Need at least threshold*2 entries to detect threshold cycles of A→B
    if (h.length < threshold * 2) return { action: 'allow' };

    const recent = h.slice(-threshold * 2);

    // Check if the last N*2 entries follow a strict A→B→A→B pattern
    // with IDENTICAL args each time (different args = legitimate exploration).
    // Anchor on the MOST RECENT pair to avoid a false early-return when the
    // oldest two entries happen to be the same tool.
    const a = recent[recent.length - 2]!;
    const b = recent[recent.length - 1]!;
    if (a.toolName === b.toolName) return { action: 'allow' };

    let isPingPong = true;
    for (let i = 0; i < recent.length; i++) {
      const expected = i % 2 === 0 ? a : b;
      if (recent[i].toolName !== expected.toolName || recent[i].argsHash !== expected.argsHash) {
        isPingPong = false;
        break;
      }
    }

    if (isPingPong) {
      return {
        action: 'abort',
        reason: `Ping-pong detector: tools "${a.toolName}" and "${b.toolName}" alternating with identical args for ${threshold} cycles — aborting.`,
      };
    }

    return { action: 'allow' };
  }

  /** Detector 3: total tool calls in this turn exceed budget. */
  private _checkBudget(): LoopGuardResult {
    if (this.totalCalls >= BUDGET_ABORT_THRESHOLD) {
      return {
        action: 'abort',
        reason: `Budget detector: ${this.totalCalls} tool calls in one turn (limit: ${BUDGET_ABORT_THRESHOLD}) — aborting.`,
      };
    }

    if (this.totalCalls >= BUDGET_WARN_THRESHOLD) {
      return {
        action: 'warn',
        reason: `Budget detector: ${this.totalCalls} tool calls in this turn (warn limit: ${BUDGET_WARN_THRESHOLD}). Approaching abort threshold.`,
      };
    }

    return { action: 'allow' };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Consult the persistent store. Returns 'abort' if the about-to-be-recorded
   * call matches a known-bad signature (this turn's repeat signature OR a
   * ping-pong signature paired with the immediately previous call). Returns
   * 'allow' when no store is wired or no match crosses the suppress threshold.
   */
  private _checkFastSuppress(toolName: string, argsHash: string): LoopGuardResult {
    const store = this.signatureStore ?? getGlobalLoopSignatureStore();
    if (!store) return { action: 'allow' };

    if (REPEAT_EXEMPT_TOOLS.has(toolName)) return { action: 'allow' };

    const repeatSig = repeatSignature(toolName, argsHash);
    if (store.shouldSuppress(repeatSig, this.suppressHits)) {
      return {
        action: 'abort',
        reason: `Loop signature ${repeatSig} known across sessions — aborting before in-turn thresholds.`,
      };
    }

    // Ping-pong: check pair with the most recent prior call (the one BEFORE
    // we appended this call). If we already aborted on this A/B pair in a
    // prior session, short-circuit now.
    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2]!;
      if (prev.toolName !== toolName || prev.argsHash !== argsHash) {
        const ppSig = pingPongSignature(prev.toolName, prev.argsHash, toolName, argsHash);
        if (store.shouldSuppress(ppSig, this.suppressHits)) {
          return {
            action: 'abort',
            reason: `Ping-pong signature ${ppSig} known across sessions — aborting before in-turn thresholds.`,
          };
        }
      }
    }

    return { action: 'allow' };
  }

  /**
   * Write the current call's signature to the persistent store on abort.
   * Records both the repeat-style signature (always applicable) and, when
   * the abort looks like ping-pong (last two distinct calls form a stable
   * pair), the ping-pong signature too — so either detector triggering it
   * again next time also benefits from fast-suppress.
   */
  private _persistAbortSignature(toolName: string, argsHash: string): void {
    const store = this.signatureStore ?? getGlobalLoopSignatureStore();
    if (!store) return;
    try {
      store.record(repeatSignature(toolName, argsHash));
      if (this.history.length >= 2) {
        const prev = this.history[this.history.length - 2]!;
        if (prev.toolName !== toolName || prev.argsHash !== argsHash) {
          store.record(pingPongSignature(prev.toolName, prev.argsHash, toolName, argsHash));
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'LoopGuard: signature persist failed (non-fatal)');
    }
  }

  private _hashArgs(args: Record<string, unknown>): string {
    try {
      return contentHash(this._stableStringify(args));
    } catch {
      // Unique per-call nonce so serialisation failures never collapse distinct
      // calls onto the same key and falsely trip the repeat threshold.
      return `unhashable:${this.totalCalls}:${Math.random().toString(36).slice(2)}`;
    }
  }

  /**
   * Deterministically serialize a value, recursively sorting object keys so
   * that two structurally-identical arguments always produce the same string
   * regardless of key insertion order. Unlike JSON.stringify's replacer-array
   * form, this preserves nested object/array values.
   */
  private _stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => this._stableStringify(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${this._stableStringify(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
}
