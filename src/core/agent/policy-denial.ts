/**
 * @file policy-denial.ts
 * @description Policy-denial recognition + turn-scoped escalation tracker.
 *
 * A POLICY denial is categorically different from a transient tool error:
 * retrying the same tool cannot succeed, because a gate (eval-sandbox policy,
 * plan-mode gate, PermissionManager deny-mode) rejected the call before it
 * ran. Live eval-sandbox runs (ADR-0007, scenario `unreliable-service`)
 * proved the model treats a denial ToolResult like any other error and
 * retries the denied tool instead of switching — so the loop escalates:
 *
 *   1st denial of a tool in a turn → inject a system-style nudge ("this tool
 *      is unavailable by policy — choose a different tool, do not retry").
 *   2nd denial of the SAME tool in the same turn → remove the tool from the
 *      schema presented on subsequent iterations of THIS turn (turn-scoped,
 *      never persisted).
 *
 * There is no single denial convention in the codebase today; the gates each
 * phrase their denial differently. This module centralizes recognition of
 * the existing phrasings (general mechanism — nothing eval-specific):
 *
 *   - eval-sandbox gate (registry.ts):        `eval-policy: <reason>`
 *   - plan-mode gate (registry.ts, thrown ToolError, surfaced by tool-exec
 *     as "Error executing tool …"):           `Plan mode active (…) —
 *     destructive tool '…' is blocked until the plan is approved`
 *   - PermissionManager deny mode (tool-batch.ts): `[PermissionManager] Tool
 *     execution permanently denied: <name>`
 *
 * Deliberately NOT covered: interactive user denials ("Tool execution denied
 * by user") — a user may approve the same tool moments later, so removing it
 * from the schema would drop a capability the user still controls.
 */

/**
 * Recognizers for policy-denial ToolResult content. Multiline anchors where
 * the denial text starts the result line (hints may be prepended/appended by
 * tool-exec commit annotations); the plan-mode phrase is matched unanchored
 * because it arrives wrapped in "Error executing tool …: ToolError: …".
 */
export const POLICY_DENIAL_PATTERNS: readonly RegExp[] = [
  /^eval-policy:/m,
  /Plan mode active .{0,80}is blocked until the plan is approved/,
  /^\[PermissionManager\] Tool execution permanently denied:/m,
];

/** True when a tool-result string is a policy denial (not a transient error). */
export function isPolicyDenial(content: string): boolean {
  return POLICY_DENIAL_PATTERNS.some((re) => re.test(content));
}

export type PolicyDenialVerdict = 'nudge' | 'remove' | 'already-removed';

/**
 * Turn-scoped denial tracker. Construct one per inner-loop invocation
 * (mirrors the swarm-rescue latch pattern); never persist it.
 */
export class TurnPolicyDenialTracker {
  private readonly counts = new Map<string, number>();
  private readonly removed = new Set<string>();

  /** Record a policy denial for a tool; returns the escalation verdict. */
  record(toolName: string): PolicyDenialVerdict {
    const n = (this.counts.get(toolName) ?? 0) + 1;
    this.counts.set(toolName, n);
    if (n === 1) return 'nudge';
    if (this.removed.has(toolName)) return 'already-removed';
    this.removed.add(toolName);
    return 'remove';
  }

  /** Tools removed from this turn's schema (2+ policy denials). */
  get removedTools(): ReadonlySet<string> {
    return this.removed;
  }

  /** Denial count for diagnostics/tests. */
  getCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }
}
