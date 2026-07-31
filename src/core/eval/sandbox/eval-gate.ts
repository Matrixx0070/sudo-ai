/**
 * @file eval-gate.ts
 * @description Eval-sandbox tool gate (ADR-0007). Module-scoped active-run
 * registry, exact same architectural pattern as the rewind hook
 * (src/core/rewind/index.ts): the ToolRegistry choke point calls
 * `evalGateBeforeTool` on every execution; the hook is a zero-work allow
 * unless an eval run is active in THIS process AND SUDO_EVAL=1.
 *
 * Phase 2 adds fault injection (deny/delay/error before the tool, corrupt on
 * the result) and conditional deny rules (`{ tool, whenParamsMatch }`).
 *
 * Fail-open contract: every internal error allows — the only path to a deny
 * is an explicit policy match or an injected fault. The hot path outside an
 * eval run is untouched (two cheap checks, no logging, no allocation).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { DenyRule, ScenarioFault, ScenarioPolicy } from './scenario.js';
import { RunJournal, sha256Hex, truncateForJournal } from './run-journal.js';

export interface EvalRunContext {
  runId: string;
  policy: ScenarioPolicy;
  journal: RunJournal;
  faults?: ScenarioFault[];
  /**
   * L1 replay path remap (Phase 3): the recorded trajectory's tool_use params
   * carry the ORIGINAL run's absolute workspace path; without a remap, live
   * tools during replay would mutate the archived original workspace while
   * graders check the replay run's fresh one. When set, every string param is
   * deep-rewritten `from` → `to` before execution.
   */
  pathRemap?: { from: string; to: string };
}

export type GateDecision =
  /** `params`, when present, are the transformed params the tool must run with. */
  | { action: 'allow'; params?: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  /** Injected fault: the tool never runs; the agent sees a failed ToolResult. */
  | { action: 'error'; message: string };

const ALLOW: GateDecision = { action: 'allow' };

/** Per-fault per-run counters: matching calls seen, injections performed. */
interface FaultState {
  calls: number;
  injected: number;
}

let activeRun: EvalRunContext | null = null;
let faultStates: FaultState[] = [];

export function activateEvalGate(ctx: EvalRunContext): void {
  activeRun = ctx;
  faultStates = (ctx.faults ?? []).map(() => ({ calls: 0, injected: 0 }));
}

export function deactivateEvalGate(): void {
  activeRun = null;
  faultStates = [];
}

export function evalGateActive(): boolean {
  return activeRun !== null && process.env['SUDO_EVAL'] === '1';
}

/**
 * Deep-rewrite every string leaf, replacing ALL occurrences of `from` with
 * `to` — recursively through plain objects and arrays; non-string leaves are
 * untouched. Returns the (possibly new) value and the replacement count.
 * Exported for tests.
 */
export function remapStringsDeep(value: unknown, from: string, to: string): { value: unknown; count: number } {
  if (from === '') return { value, count: 0 };
  if (typeof value === 'string') {
    const parts = value.split(from);
    if (parts.length > 1) return { value: parts.join(to), count: parts.length - 1 };
    // Tolerant pass: the LLM ledger REDACTS token-like strings at persist time
    // (live-proven: replay.db ir_response holds "coding-ta[REDACTED]/workspace"),
    // so an exact match can miss. Match the same path SHAPE with the run-id
    // segment wildcarded, still anchored on the full parent prefix.
    const shape = from.match(/^(.*)\/[^/]+\/(workspace)$/);
    if (shape !== null) {
      const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${esc(shape[1]!)}/[^/]+/${shape[2]!}`, 'g');
      let count = 0;
      const replaced = value.replace(re, () => { count += 1; return to; });
      if (count > 0) return { value: replaced, count };
    }
    return { value, count: 0 };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const r = remapStringsDeep(v, from, to);
      count += r.count;
      return r.value;
    });
    return count > 0 ? { value: out, count } : { value, count: 0 };
  }
  if (value !== null && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = remapStringsDeep(v, from, to);
      count += r.count;
      out[k] = r.value;
    }
    return count > 0 ? { value: out, count } : { value, count: 0 };
  }
  return { value, count: 0 };
}

/** Exact name or namespace glob ("fs.*") match, mirroring the loop's allowlist style. */
function matchesRule(rule: string, toolName: string): boolean {
  if (rule === toolName) return true;
  if (rule.endsWith('.*')) return toolName.startsWith(rule.slice(0, -1));
  return false;
}

/**
 * Deny-rule DSL: a plain string matches by name/glob (Phase 1, unchanged); an
 * object rule additionally requires the JSON-serialized params to match its
 * regex. A malformed regex never denies (fail-open).
 */
function matchesDenyRule(rule: DenyRule, toolName: string, paramsJson: string): boolean {
  if (typeof rule === 'string') return matchesRule(rule, toolName);
  if (!matchesRule(rule.tool, toolName)) return false;
  try {
    return new RegExp(rule.whenParamsMatch).test(paramsJson);
  } catch {
    return false;
  }
}

function denyRuleLabel(rule: DenyRule): string {
  return typeof rule === 'string' ? rule : `${rule.tool}~/${rule.whenParamsMatch}/`;
}

/**
 * Count a call against every fault matching (tool, kinds) and return the first
 * fault that becomes eligible to inject: past its afterNCalls warm-up and under
 * its count cap. Counters are per-fault per-run (reset by activateEvalGate).
 */
function takeFault(
  toolName: string,
  kinds: ReadonlyArray<ScenarioFault['kind']>,
): ScenarioFault | null {
  const faults = activeRun?.faults ?? [];
  let hit: ScenarioFault | null = null;
  for (let i = 0; i < faults.length; i++) {
    const fault = faults[i]!;
    const state = faultStates[i]!;
    if (!kinds.includes(fault.kind) || !matchesRule(fault.tool, toolName)) continue;
    const callIndex = state.calls;
    state.calls += 1;
    if (hit !== null) continue;
    if (callIndex < (fault.afterNCalls ?? 0)) continue;
    if (fault.count !== undefined && state.injected >= fault.count) continue;
    state.injected += 1;
    hit = fault;
  }
  return hit;
}

function journalFault(name: string, fault: ScenarioFault): void {
  try {
    activeRun?.journal.append({
      type: 'fault.injected',
      name,
      tool: fault.tool,
      kind: fault.kind,
      ...(fault.delayMs !== undefined ? { delayMs: fault.delayMs } : {}),
    });
  } catch {
    /* journaling never blocks an injection */
  }
}

/**
 * Policy decision for one tool call. Journals tool.call + policy.decision when
 * a run is active, then applies before-phase injected faults (deny/delay/
 * error). NEVER throws; internal errors → allow (fail-open).
 */
export async function evalGateBeforeTool(
  name: string,
  params: Record<string, unknown>,
): Promise<GateDecision> {
  if (activeRun === null || process.env['SUDO_EVAL'] !== '1') return ALLOW;

  // L1 replay path remap: rewrite the ORIGINAL run's workspace path to the
  // replay run's workspace in every string param, BEFORE policy matching,
  // journaling, and execution. Inert when no mapping is set.
  let remappedParams: Record<string, unknown> | undefined;
  const remap = activeRun.pathRemap;
  if (remap !== undefined) {
    try {
      const r = remapStringsDeep(params ?? {}, remap.from, remap.to);
      if (r.count > 0) {
        remappedParams = r.value as Record<string, unknown>;
        params = remappedParams;
        try {
          activeRun.journal.append({ type: 'replay.path-remap', name, replacements: r.count });
        } catch { /* journaling never blocks the remap */ }
      }
    } catch { /* fail-open: run with the original params */ }
  }

  const allowDecision: GateDecision =
    remappedParams !== undefined ? { action: 'allow', params: remappedParams } : ALLOW;

  let paramsJson = '{}';
  try {
    paramsJson = JSON.stringify(params ?? {});
  } catch {
    /* unserializable params — conditional deny rules just won't match */
  }

  let decision: GateDecision = allowDecision;
  let matchedRule = '';
  try {
    const tools = activeRun.policy.tools;
    const denyRule = (tools?.deny ?? []).find((r) => matchesDenyRule(r, name, paramsJson));
    if (denyRule !== undefined) {
      matchedRule = `deny:${denyRuleLabel(denyRule)}`;
      decision = { action: 'deny', reason: `tool '${name}' is denied by scenario policy (${denyRuleLabel(denyRule)})` };
    } else if (tools?.allow && !tools.allow.some((r) => matchesRule(r, name))) {
      matchedRule = 'allow-list';
      decision = { action: 'deny', reason: `tool '${name}' is not on the scenario allow list` };
    }
  } catch {
    return allowDecision;
  }

  // Journaling is best-effort and must not change the decision either way.
  try {
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
  if (decision.action !== 'allow') return decision;

  // Before-phase fault injection (Phase 2): deny / delay / error.
  try {
    const fault = takeFault(name, ['deny', 'delay', 'error']);
    if (fault !== null) {
      journalFault(name, fault);
      if (fault.kind === 'deny') {
        return { action: 'deny', reason: `injected fault: tool '${name}' denied` };
      }
      if (fault.kind === 'error') {
        return { action: 'error', message: fault.errorMessage ?? `injected fault: tool '${name}' failed` };
      }
      await sleep(fault.delayMs ?? 1000);
    }
  } catch {
    return allowDecision;
  }
  return allowDecision;
}

/**
 * Journal a completed tool result and apply corrupt-phase faults: a 'corrupt'
 * fault replaces a SUCCESSFUL result's output (the journal records what the
 * agent actually saw). Identity pass-through when no run is active. NEVER throws.
 */
export function evalGateAfterTool<T extends { success: boolean; output: string }>(
  name: string,
  result: T,
): T {
  if (activeRun === null || process.env['SUDO_EVAL'] !== '1') return result;
  let out = result;
  try {
    if (result.success) {
      const fault = takeFault(name, ['corrupt']);
      if (fault !== null) {
        journalFault(name, fault);
        out = { ...result, output: fault.corruptWith ?? '' };
      }
    }
  } catch {
    out = result;
  }
  try {
    const output = typeof out.output === 'string' ? out.output : String(out.output);
    activeRun.journal.append({
      type: 'tool.result',
      name,
      ok: out.success,
      outputSha256: sha256Hex(output),
      output: truncateForJournal(output),
    });
  } catch {
    /* fail-open */
  }
  return out;
}
