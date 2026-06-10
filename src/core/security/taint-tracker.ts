/**
 * @file security/taint-tracker.ts
 * @description Data provenance taint tracking for SUDO-AI.
 *
 * Propagation rules (from wave10-spec.md Section B11):
 *   Rule 1: Every ToolCallResult from external tool → Taint{level='medium', source='tool_output'}.
 *   Rule 2: When input refs prior tainted result, new result inherits MAX(ancestor levels).
 *   Rule 3: TaintTracker subscribes to HookManager 'after:tool-call'. Emits 'taint-assigned'.
 *   Rule 4: taint.level >= 'high' AND next tool is 'destructive' → emit 'taint-violation', return BLOCK.
 *   Rule 5: Tools with category 'security' may output level='clean'.
 *
 * The tracker is a passive observer — it does NOT modify tool call results.
 * Violation detection is a gate called by the agent loop before executing write/destructive tools.
 *
 * @module security/taint-tracker
 */

import crypto from 'node:crypto';
import type { Taint, TaintLevel, TaintSource, TaintViolation, TaintSet } from '../shared/wave10-types.js';
import type { HookManager } from '../hooks/index.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security:taint-tracker');

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<TaintLevel, number> = {
  clean: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxLevel(a: TaintLevel, b: TaintLevel): TaintLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Destructive tool detection
// ---------------------------------------------------------------------------

/**
 * Heuristic: tool names that indicate destructive side-effects.
 * Pattern: write/delete/execute/send operations across all categories.
 */
const DESTRUCTIVE_PATTERNS = [
  /\.write$/i,
  /\.delete$/i,
  /\.remove$/i,
  /\.exec$/i,
  /\.shell/i,
  /\.send$/i,
  /\.post$/i,
  /\.deploy$/i,
  /\.overwrite/i,
  /system\.shell/i,
];

function isDestructiveTool(toolName: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(p => p.test(toolName));
}

// ---------------------------------------------------------------------------
// TaintTracker class
// ---------------------------------------------------------------------------

/**
 * Manages a set of active taints and enforces propagation rules.
 *
 * Attach to a HookManager via {@link TaintTracker.attachHooks} to receive
 * automatic taint assignment on every tool result event.
 */
export class TaintTracker {
  private readonly _taints: TaintSet = new Map();
  /** Registered HookManager (for emitting taint events). */
  private _hooks: HookManager | null = null;

  // -------------------------------------------------------------------------
  // Hook wiring
  // -------------------------------------------------------------------------

  /**
   * Subscribe to HookManager events.
   *
   * Listens to 'after:tool-call' to auto-tag every tool result.
   * Emits custom hook meta events 'taint-assigned' and 'taint-violation'.
   *
   * @param hooks - The application's central HookManager.
   */
  attachHooks(hooks: HookManager): void {
    this._hooks = hooks;

    // D1: reset idle-guard timer on re-attach
    _startIdleGuard(this);

    hooks.register(
      'after:tool-call',
      async (ctx) => {
        // D2 re-entry guard: the re-emit below fires ALL 'after:tool-call' handlers,
        // including this one. Without this guard, the handler enters infinite recursion.
        // Any future handler on 'after:tool-call' MUST add an identical guard.
        if (ctx.meta?.['taintEvent']) return;
        if (!ctx.toolName) return;

        const taintId = ctx.meta?.['taintId'] as string | undefined;
        const parentIds = Array.isArray(ctx.meta?.['ancestorTaintIds'])
          ? (ctx.meta['ancestorTaintIds'] as string[])
          : [];

        // INFO-2: skip tag() when the loop has already called onToolResult() and forwarded
        // the taintId in meta.  onToolResult in loop.ts is the canonical tagging path.
        // When taintId is already present in our store we act as a telemetry re-emitter only
        // (no duplicate allocation).  Propagation runs on its own path via ancestorTaintIds.
        const loopAlreadyTagged = taintId !== undefined && this._taints.has(taintId);
        const taint = parentIds.length > 0
          ? this.propagate(parentIds, ctx.toolName)
          : loopAlreadyTagged
            ? this._taints.get(taintId!)!
            : this.tag(ctx.toolName, 'tool_output');

        // FRAGILITY NOTE: This re-emit fires ALL registered 'after:tool-call' handlers,
        // not just this one. The guard at the top of this handler prevents infinite
        // recursion from our own re-entry. Any future handler registering on
        // 'after:tool-call' MUST add the same guard:
        //   if (ctx.meta?.['taintEvent']) return;
        // Without it, it will see spurious events with incomplete context (no sessionId/success).
        // A follow-on wave should replace this re-emit with a dedicated log.info call to
        // eliminate the cross-handler coupling risk entirely.
        await hooks.emit('after:tool-call', {
          event: 'after:tool-call',
          toolName: ctx.toolName,
          meta: {
            taintEvent: 'taint-assigned',
            taintId: taint.taintId,
            level: taint.level,
          },
        });

        log.debug(
          { toolName: ctx.toolName, taintId: taint.taintId, level: taint.level },
          'Taint assigned via hook',
        );

        // Store taintId on meta for downstream consumers
        if (taintId === undefined && ctx.meta) {
          (ctx.meta as Record<string, unknown>)['taintId'] = taint.taintId;
        }
      },
      'TaintTracker: tag tool results',
    );

    // D1: clear taint map on session:end to prevent memory growth.
    hooks.register(
      'session:end',
      async () => { this.clear(); },
      'TaintTracker: clear on session end',
    );

    log.info('TaintTracker attached to HookManager');
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Assign a new taint to a tool result.
   *
   * Rule 1: Default for external tools is level='medium', source='tool_output'.
   *
   * @param toolName - Name of the tool that produced the result.
   * @param source   - Origin category of the taint.
   * @param level    - Severity level (defaults to 'medium' per Rule 1).
   * @returns The created Taint (stored in the TaintSet).
   */
  tag(
    toolName: string,
    source: TaintSource,
    level: TaintLevel = 'medium',
  ): Taint {
    const taintId = crypto.randomUUID();
    const taint: Taint = {
      level,
      source,
      origin: toolName,
      taintId,
      assignedAt: new Date().toISOString(),
    };
    this._taints.set(taintId, taint);
    log.debug({ taintId, toolName, level, source }, 'Taint tagged');
    return taint;
  }

  /**
   * Propagate taint from parent results to a new result.
   *
   * Rule 2: New result inherits MAX(ancestor levels).
   *
   * @param parentTaintIds - taintId values of ancestor taints.
   * @param toolName       - Name of the tool producing the new result.
   * @returns The derived Taint with propagated level.
   */
  propagate(parentTaintIds: string[], toolName: string): Taint {
    let inheritedLevel: TaintLevel = 'medium'; // Rule 1 baseline
    let inheritedSource: TaintSource = 'tool_output';

    for (const id of parentTaintIds) {
      const ancestor = this._taints.get(id);
      if (!ancestor) continue;
      inheritedLevel = maxLevel(inheritedLevel, ancestor.level);
      // Escalate source if parent is external
      if (ancestor.source === 'external_fetch' || ancestor.source === 'channel_message') {
        inheritedSource = ancestor.source;
      }
    }

    const taintId = crypto.randomUUID();
    const taint: Taint = {
      level: inheritedLevel,
      source: inheritedSource,
      origin: toolName,
      taintId,
      assignedAt: new Date().toISOString(),
      ancestors: parentTaintIds.filter(id => this._taints.has(id)),
    };

    this._taints.set(taintId, taint);
    log.debug(
      { taintId, toolName, inheritedLevel, ancestorCount: parentTaintIds.length },
      'Taint propagated',
    );
    return taint;
  }

  /**
   * Check if a taint violates the policy for the given tool operation.
   *
   * Rule 4: taint.level >= 'high' AND next tool is 'destructive' → BLOCK.
   *
   * @param toolName  - Tool about to be called.
   * @param safety    - 'readonly' or 'destructive' — caller classifies the tool.
   * @param taintId   - The active taint to check against.
   * @returns TaintViolation if blocked, null if allowed.
   */
  checkViolation(
    toolName: string,
    safety: 'readonly' | 'destructive',
    taintId: string,
  ): TaintViolation | null {
    const taint = this._taints.get(taintId);
    if (!taint) return null;

    const isHighOrCritical =
      taint.level === 'high' || taint.level === 'critical';

    const destructive =
      safety === 'destructive' || isDestructiveTool(toolName);

    if (isHighOrCritical && destructive) {
      const violation: TaintViolation = {
        taint,
        toolName,
        reason: `Tool "${toolName}" is destructive but input carries ${taint.level} taint (origin: ${taint.origin}). Blocked by taint policy.`,
        timestamp: new Date().toISOString(),
      };

      log.warn(
        { toolName, taintId, level: taint.level },
        'Taint violation: destructive tool blocked',
      );

      // Emit violation if hooks are attached
      if (this._hooks) {
        this._hooks.emit('before:tool-call', {
          event: 'before:tool-call',
          toolName,
          meta: {
            taintEvent: 'taint-violation',
            taintId,
            level: taint.level,
            reason: violation.reason,
          },
        }).catch(() => { /* non-fatal */ });
      }

      return violation;
    }

    return null;
  }

  /**
   * Convenience method called from agent loop after each tool result.
   *
   * Automatically tags the result and returns the taint.
   * Caller can pass ancestorTaintIds to trigger propagation (Rule 2).
   *
   * @param event - Tool result event from the agent loop.
   * @returns The assigned Taint.
   */
  onToolResult(event: {
    name: string;
    result: unknown;
    taintId?: string;
    ancestorTaintIds?: string[];
  }): Taint {
    const { name, ancestorTaintIds } = event;

    if (ancestorTaintIds && ancestorTaintIds.length > 0) {
      return this.propagate(ancestorTaintIds, name);
    }

    return this.tag(name, 'tool_output');
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  /** Get a copy of a stored taint by ID (returns undefined if not found). */
  getTaint(taintId: string): Taint | undefined {
    return this._taints.get(taintId);
  }

  /** Current count of tracked taints. */
  get size(): number {
    return this._taints.size;
  }

  /** Clear all stored taints (use at session end to avoid memory growth). */
  clear(): void {
    this._taints.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Default singleton TaintTracker. Wire to HookManager at boot. */
export const taintTracker = new TaintTracker();

// ---------------------------------------------------------------------------
// D1 Idle-guard: clear taint map hourly to prevent unbounded growth in
// long-running sessions that never fire session:end (e.g., crashed processes).
// Timer is unref'd so it does not prevent process exit.
// Reset on each attachHooks() call to extend the window from the last attach.
// ---------------------------------------------------------------------------

let _idleTimer: ReturnType<typeof setInterval> | undefined;

function _startIdleGuard(tracker: TaintTracker): void {
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = setInterval(() => { tracker.clear(); }, 60 * 60 * 1000);
  (_idleTimer as NodeJS.Timeout).unref();
}

// Start idle-guard immediately for the default singleton.
_startIdleGuard(taintTracker);
