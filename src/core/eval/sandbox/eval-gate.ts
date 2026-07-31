/**
 * @file eval-gate.ts
 * @description Eval-sandbox tool gate (ADR-0007). Module-scoped active-run
 * registry, exact same architectural pattern as the rewind hook
 * (src/core/rewind/index.ts): the ToolRegistry choke point calls
 * `evalGateBeforeTool` on every execution; the hook is a zero-work allow
 * unless an eval run is active in THIS process AND SUDO_EVAL=1.
 *
 * Fail-open contract: every internal error allows — the only path to a deny
 * is an explicit policy match. The hot path outside an eval run is untouched
 * (two cheap checks, no logging, no allocation).
 */

import type { ScenarioPolicy } from './scenario.js';
import { RunJournal, sha256Hex, truncateForJournal } from './run-journal.js';

export interface EvalRunContext {
  runId: string;
  policy: ScenarioPolicy;
  journal: RunJournal;
}

export type GateDecision = { action: 'allow' } | { action: 'deny'; reason: string };

const ALLOW: GateDecision = { action: 'allow' };

let activeRun: EvalRunContext | null = null;

export function activateEvalGate(ctx: EvalRunContext): void {
  activeRun = ctx;
}

export function deactivateEvalGate(): void {
  activeRun = null;
}

export function evalGateActive(): boolean {
  return activeRun !== null && process.env['SUDO_EVAL'] === '1';
}

/** Exact name or namespace glob ("fs.*") match, mirroring the loop's allowlist style. */
function matchesRule(rule: string, toolName: string): boolean {
  if (rule === toolName) return true;
  if (rule.endsWith('.*')) return toolName.startsWith(rule.slice(0, -1));
  return false;
}

/**
 * Policy decision for one tool call. Journals tool.call + policy.decision when
 * a run is active. NEVER throws; internal errors → allow (fail-open).
 */
export function evalGateBeforeTool(
  name: string,
  params: Record<string, unknown>,
): GateDecision {
  if (activeRun === null || process.env['SUDO_EVAL'] !== '1') return ALLOW;

  let decision: GateDecision = ALLOW;
  let matchedRule = '';
  try {
    const tools = activeRun.policy.tools;
    const denyRule = (tools?.deny ?? []).find((r) => matchesRule(r, name));
    if (denyRule !== undefined) {
      matchedRule = `deny:${denyRule}`;
      decision = { action: 'deny', reason: `tool '${name}' is denied by scenario policy (${denyRule})` };
    } else if (tools?.allow && !tools.allow.some((r) => matchesRule(r, name))) {
      matchedRule = 'allow-list';
      decision = { action: 'deny', reason: `tool '${name}' is not on the scenario allow list` };
    }
  } catch {
    return ALLOW;
  }

  // Journaling is best-effort and must not change the decision either way.
  try {
    const paramsJson = JSON.stringify(params ?? {});
    activeRun.journal.append({
      type: 'tool.call',
      name,
      paramsSha256: sha256Hex(paramsJson),
      params: truncateForJournal(paramsJson),
    });
    activeRun.journal.append({
      type: 'policy.decision',
      name,
      action: decision.action,
      rule: matchedRule || 'default-allow',
    });
  } catch {
    /* journal failure never blocks or unblocks a tool */
  }
  return decision;
}

/** Journal a completed tool result. No-op when no run is active. NEVER throws. */
export function evalGateAfterTool(
  name: string,
  result: { success: boolean; output: string },
): void {
  if (activeRun === null || process.env['SUDO_EVAL'] !== '1') return;
  try {
    const output = typeof result.output === 'string' ? result.output : String(result.output);
    activeRun.journal.append({
      type: 'tool.result',
      name,
      ok: result.success,
      outputSha256: sha256Hex(output),
      output: truncateForJournal(output),
    });
  } catch {
    /* fail-open */
  }
}
