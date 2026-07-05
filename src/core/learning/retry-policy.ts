/**
 * @file learning/retry-policy.ts
 * @description A FOURTH verification mode: retry-POLICY repairs, verified by looking
 * FORWARD in trace sequences.
 *
 * The other three modes fix the CALL (rewrite the input, teach a command, fix an
 * ordering). A retry-policy fixes the HARNESS's REACTION to a failure: "when tool X
 * fails with error E, automatically do a recovery action R and retry." The canonical
 * case is browser.click failing "ref not found on the page" — today the tool gives up
 * and asks the agent to snapshot again; the policy would re-snapshot and retry once.
 *
 * You verify a retry-policy from data where the agent ALREADY performed the recovery
 * manually: for each failure, look forward in the session — did a recovery action
 * (browser.snapshot) followed by a successful retry (browser.click) occur? The
 * fraction that recovered is the policy's proven efficacy. A high rate means the
 * automatic policy would reliably work; a low rate means it wouldn't, and the gate
 * (reused unchanged) rejects it.
 *
 * SAFETY / APPLY BOUNDARY (important, deliberate): unlike lessons — advisory TEXT the
 * canary can inject and auto-revert — a retry-policy is a CODE change to the tool/loop.
 * That is NOT something this system auto-applies (auto-mutating harness code is the one
 * line we never cross unattended). So a verified retry-policy is a REPORTED
 * RECOMMENDATION only: the scanner logs "policy P would recover X% — implement it".
 * Applying it is a human-reviewed code change (e.g. auto-re-snapshot in click.ts).
 */
import { decideAdoption, type AdoptionDecision, type AdoptionThresholds, DEFAULT_ADOPTION_THRESHOLDS } from './repair-flywheel-verify.js';
import type { ToolEvent } from './workflow-order.js';

/** A repair expressed as an automatic failure→recovery→retry policy. */
export interface RetryPolicyRepair {
  policyId: string;
  /** The tool that fails and would be retried. */
  tool: string;
  /** Human description of the policy (for the recommendation log). */
  description: string;
  /** Identifies the target failure cluster in error_message (JS includes + SQL LIKE). */
  errorPattern: string;
  /** The recovery action that must succeed after the failure (e.g. browser.snapshot). */
  recoveryTool: (tool: string) => boolean;
  /** A successful retry of the operation (e.g. browser.click) that follows the recovery. */
  retryTool: (tool: string) => boolean;
  /** How far forward in the same session a recovery+retry still counts (ms). */
  forwardWindowMs: number;
}

export interface RetryPolicyResult {
  /** Matching cluster failures examined (with a usable session). */
  failures: number;
  /** Failures followed by recovery-action + successful retry — the policy would recover. */
  recovered: number;
  /** Failures with no observed successful recovery. */
  unrecovered: number;
  /** recovered / failures, 0..100. */
  recoveryPct: number;
  sessionsSeen: number;
}

/**
 * Verify a retry-policy over tool events. For each matching failure, look forward in the
 * same session for a successful recovery action followed by a successful retry, both
 * within the window. Pure.
 */
export function verifyRetryPolicy(events: ToolEvent[], repair: RetryPolicyRepair): RetryPolicyResult {
  const bySession = new Map<string, ToolEvent[]>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const arr = bySession.get(e.sessionId) ?? [];
    arr.push(e);
    bySession.set(e.sessionId, arr);
  }

  let failures = 0;
  let recovered = 0;
  for (const [, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < sessionEvents.length; i++) {
      const ev = sessionEvents[i]!;
      if (ev.tool !== repair.tool || ev.success || !ev.errorMessage.includes(repair.errorPattern)) continue;
      failures += 1;

      // Forward scan: a successful recovery action, THEN a successful retry, in window.
      let sawRecovery = false;
      for (let j = i + 1; j < sessionEvents.length; j++) {
        const nxt = sessionEvents[j]!;
        if (nxt.createdAtMs - ev.createdAtMs > repair.forwardWindowMs) break; // out of window
        if (!nxt.success) continue;
        if (repair.recoveryTool(nxt.tool)) { sawRecovery = true; continue; }
        if (sawRecovery && repair.retryTool(nxt.tool)) { recovered += 1; break; }
      }
    }
  }

  return {
    failures,
    recovered,
    unrecovered: failures - recovered,
    recoveryPct: failures > 0 ? Math.round((1000 * recovered) / failures) / 10 : 0,
    sessionsSeen: bySession.size,
  };
}

/**
 * Adoption gate for a retry-policy — reuses the SAME conservative gate. Every matching
 * failure is a genuine sample (no already-ok), so genuine = failures and the rate that
 * must clear the bar = recoveryPct.
 */
export function decideRetryPolicyAdoption(
  r: RetryPolicyResult,
  thresholds: AdoptionThresholds = DEFAULT_ADOPTION_THRESHOLDS,
): AdoptionDecision {
  return decideAdoption({ tried: r.failures, alreadyOk: 0, recovered: r.recovered, recoveryPct: r.recoveryPct }, thresholds);
}

/**
 * The browser ref-not-found retry policy: on "ref not found on the page", re-snapshot
 * and retry the click once. Verified where the agent already did snapshot→click after
 * the failure. If proven, the concrete apply is a guarded auto-re-snapshot in click.ts
 * (a human-reviewed CODE change) — this class only recommends it.
 */
export function makeBrowserRefRetryPolicy(): RetryPolicyRepair {
  return {
    policyId: 'browser-ref-resnapshot-retry',
    tool: 'browser.click',
    description: 'On "ref not found on the page", re-run browser.snapshot to rebuild refs, then retry the click once before failing.',
    errorPattern: 'not found on the page',
    recoveryTool: (tool) => tool === 'browser.snapshot',
    retryTool: (tool) => tool === 'browser.click',
    forwardWindowMs: 3 * 60 * 1000, // recovery within ~3 min of the failure
  };
}

/** Registered retry-policies the flywheel verifies from trace sequences. */
export const RETRY_POLICIES: RetryPolicyRepair[] = [makeBrowserRefRetryPolicy()];
