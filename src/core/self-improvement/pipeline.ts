/**
 * @file self-improvement/pipeline.ts
 * @description AL8.2 uniform improvement pipeline — ONE contract for all four
 * self-authored artifact types (prompt, workflow-graph, tool, code-patch):
 *
 *   budget → propose → validate (plugin) → bench (gate) → quarantine → PR
 *
 * A thin layer over the EXISTING seams, never parallel plumbing:
 *   - propose: rows in learning/proposal-store.ts (artifact rides `delta`,
 *     agentId = 'pipeline:<type>'), so the existing human HTTP approve/reject
 *     routes work unchanged — and markApplied finally gets its caller
 *     (recordHumanMerge below closes the Campaign-4 "apply stage missing"
 *     finding).
 *   - validate: artifact-type plugins (pipeline-plugins.ts) own how their
 *     artifact is checked; the pipeline only enforces THAT it happens.
 *   - bench: the HeldOutGate seam (learning/held-out-gate.ts). ABSENT GATE
 *     HOLDS — invariant 8, and the AL8.0 R1 lesson: no-eval never means
 *     no-gate on an autonomous path.
 *   - quarantine: injected inspector over ALL human-facing PR text (AL8.5 —
 *     self-authored text on the control path is untrusted model output).
 *   - PR: injected opener (self-build/review-pr.ts pattern). HUMAN MERGE
 *     ALWAYS — this pipeline cannot merge anything (AL8.6 default stands:
 *     no auto-merge; that gate is Frank's, by memo).
 *
 * Every stage is fail-closed and every run returns the full stage trace —
 * a held pipeline names exactly which stage held and why.
 */

import { createLogger } from '../shared/logger.js';
import type { AgentConfigProposal } from '../shared/wave10-types.js';
import type { AdoptionRecord } from './retention-ledger.js';
import { CURRENT_MANIFEST, type PipelineManifest } from './pipeline-manifest.js';

const log = createLogger('self-improvement:pipeline');

export type ArtifactType = 'prompt' | 'workflow-graph' | 'tool' | 'code-patch' | 'pipeline-change';

/** A candidate improvement, before it becomes a stored proposal. */
export interface ImprovementDraft {
  type: ArtifactType;
  title: string;
  /** Why this change should exist — stored as the proposal rationale. */
  rationale: string;
  /** How the author intends it to be evaluated — required, part of propose. */
  evalPlan: string;
  /** Artifact content, interpreted by the type's plugin. */
  payload: unknown;
}

export interface ArtifactPlugin {
  type: ArtifactType;
  /** Sandbox-validate stage: the plugin owns HOW its artifact is checked. */
  validate(draft: ImprovementDraft): Promise<{ ok: boolean; detail: string }>;
}

export type PipelineStage = 'budget' | 'propose' | 'validate' | 'bench' | 'quarantine' | 'pr';

export interface StageResult {
  stage: PipelineStage;
  ok: boolean;
  detail: string;
}

export interface PipelineOutcome {
  /** Set once the propose stage stored a row (held runs keep it for audit). */
  proposalId?: string;
  stages: StageResult[];
  /** 'pr-opened' = awaiting HUMAN merge; 'held' = a stage blocked, named in stages. */
  status: 'pr-opened' | 'held';
  prUrl?: string;
}

export interface PipelineDeps {
  /** learning/proposal-store.ts surface (duck-typed). */
  store: {
    save(p: AgentConfigProposal): unknown;
    markApplied(id: string): unknown;
  };
  plugins: ArtifactPlugin[];
  /**
   * Bench-vs-baseline seam (HeldOutGate.evaluate). ABSENT → the bench stage
   * HOLDS. Judge independence is the gate's own contract (invariant 7).
   */
  gate?: {
    evaluate(
      proposalId: string,
      action: { params: Record<string, unknown> },
    ): Promise<{ passed: boolean; passRate: number }>;
  };
  /**
   * AL8.5 quarantine seam over PR-bound text (compose with the F18
   * inspector via pipeline-wiring.f18Quarantine, or supply your own).
   * ABSENT → the quarantine stage HOLDS. Sync or async.
   */
  quarantine?: (text: string) => { ok: boolean; detail: string } | Promise<{ ok: boolean; detail: string }>;
  /** PR opener (review-pr pattern). ABSENT → held at the pr stage. */
  openPr?: (draft: ImprovementDraft, evidence: string) => Promise<{ url: string }>;
  /** Per-day proposal-count budget (invariant 10). Required. */
  budget: { maxPerDay: number };
  /**
   * AL9.1 pinned pipeline manifest (default CURRENT_MANIFEST). Every proposal
   * is stamped with THIS manifest's version at propose time, and its bench
   * bar reads from it — later manifest changes never apply retroactively
   * (AL9.5 independence ordering).
   */
  manifest?: PipelineManifest;
  /** Test seam for the day key; defaults to the current UTC date. */
  dayKey?: () => string;
}

// Day-keyed module counter (forge-budget pattern: in-process, resets on rollover).
const dayCounts = new Map<string, number>();
export function _resetPipelineBudgetForTests(): void {
  dayCounts.clear();
}

const todayKey = (): string => new Date().toISOString().slice(0, 10);

/**
 * Drive one draft through the uniform pipeline. Never throws — every failure
 * is a held outcome with the blocking stage named.
 */
export async function runImprovementPipeline(
  draft: ImprovementDraft,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const stages: StageResult[] = [];
  const manifest = deps.manifest ?? CURRENT_MANIFEST;
  const held = (proposalId?: string): PipelineOutcome => ({ proposalId, stages, status: 'held' });
  const push = (stage: PipelineStage, ok: boolean, detail: string): boolean => {
    stages.push({ stage, ok, detail });
    if (!ok) log.warn({ stage, detail, type: draft.type, title: draft.title }, 'pipeline stage held');
    return ok;
  };

  // --- budget (invariant 10: declared, fail-closed) ---
  const key = (deps.dayKey ?? todayKey)();
  const used = dayCounts.get(key) ?? 0;
  if (!Number.isInteger(deps.budget.maxPerDay) || deps.budget.maxPerDay < 1) {
    push('budget', false, `invalid maxPerDay ${deps.budget.maxPerDay} — budgets are required, not optional`);
    return held();
  }
  if (used >= deps.budget.maxPerDay) {
    push('budget', false, `daily proposal budget exhausted (${used}/${deps.budget.maxPerDay})`);
    return held();
  }
  dayCounts.set(key, used + 1);
  push('budget', true, `${used + 1}/${deps.budget.maxPerDay} today`);

  // --- propose: rationale + eval plan are mandatory, then a durable row ---
  if (!draft.rationale.trim() || !draft.evalPlan.trim()) {
    push('propose', false, 'rationale and evalPlan are required — a proposal without them is not a proposal');
    return held();
  }
  const proposalId = `pipeline-${draft.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  try {
    deps.store.save({
      id: proposalId,
      agentId: `pipeline:${draft.type}`,
      rationale: draft.rationale,
      delta: {
        artifactType: draft.type,
        title: draft.title,
        evalPlan: draft.evalPlan,
        payload: draft.payload,
        // AL9.5: the manifest ACTIVE AT PROPOSAL TIME — validation bars for
        // this artifact come from here, never from a later manifest.
        manifestVersion: manifest.version,
      },
      traceQuality: 0,
      traceCount: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    } as AgentConfigProposal);
  } catch (err) {
    push('propose', false, `proposal store rejected the row: ${err instanceof Error ? err.message : String(err)}`);
    return held();
  }
  push('propose', true, proposalId);

  // --- validate: the artifact type's plugin owns the check ---
  const plugin = deps.plugins.find((p) => p.type === draft.type);
  if (!plugin) {
    push('validate', false, `no plugin registered for artifact type "${draft.type}" — fail closed`);
    return held(proposalId);
  }
  let verdict: { ok: boolean; detail: string };
  try {
    verdict = await plugin.validate(draft);
  } catch (err) {
    verdict = { ok: false, detail: `plugin threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!push('validate', verdict.ok, verdict.detail)) return held(proposalId);

  // --- bench vs baseline: absent gate HOLDS (invariant 8) ---
  if (!deps.gate) {
    push('bench', false, 'no HeldOutGate wired — a proposal that cannot be benched cannot proceed');
    return held(proposalId);
  }
  try {
    const evalResult = await deps.gate.evaluate(proposalId, {
      params: { description: `${draft.type}: ${draft.title}`, evalPlan: draft.evalPlan },
    });
    // AL9.1: the adoption bar comes from the PINNED manifest (v1.0.0 bar = 0,
    // i.e. gate verdict only — a pure extraction of pre-manifest behavior).
    const meetsBar = evalResult.passed && evalResult.passRate >= manifest.adoption.minPassRate;
    if (!push('bench', meetsBar,
      `passRate ${evalResult.passRate.toFixed(3)} (bar ${manifest.adoption.minPassRate} @ manifest ${manifest.version})`)) {
      return held(proposalId);
    }
  } catch (err) {
    push('bench', false, `gate evaluation failed — blocking (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
    return held(proposalId);
  }

  // --- quarantine: ALL PR-bound self-authored text is untrusted (AL8.5) ---
  const evidence =
    `Artifact: ${draft.type}\nTitle: ${draft.title}\nRationale: ${draft.rationale}\n` +
    `Eval plan: ${draft.evalPlan}\nBench: ${stages.find((s) => s.stage === 'bench')?.detail ?? ''}\n` +
    `Proposal: ${proposalId}`;
  if (!deps.quarantine) {
    push('quarantine', false, 'no quarantine inspector wired — PR text cannot be cleared (fail-closed)');
    return held(proposalId);
  }
  let q: { ok: boolean; detail: string };
  try {
    q = await deps.quarantine(evidence + '\n' + draft.title + '\n' + draft.rationale);
  } catch (err) {
    q = { ok: false, detail: `inspector threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!push('quarantine', q.ok, q.detail)) return held(proposalId);

  // --- PR: human merge always; this pipeline cannot merge ---
  if (!deps.openPr) {
    push('pr', false, 'no PR opener wired — validated proposal awaits manual PR');
    return held(proposalId);
  }
  try {
    const pr = await deps.openPr(draft, evidence);
    push('pr', true, pr.url);
    log.info({ proposalId, type: draft.type, url: pr.url }, 'improvement PR opened — human merge required');
    return { proposalId, stages, status: 'pr-opened', prUrl: pr.url };
  } catch (err) {
    push('pr', false, `PR open failed: ${err instanceof Error ? err.message : String(err)}`);
    return held(proposalId);
  }
}

/**
 * The APPLY-stage closure (Campaign-4 finding: markApplied had zero callers).
 * Called AFTER a human merges the improvement PR. Harness-enforced ordering:
 * ProposalStore.markApplied throws unless the proposal was human-approved
 * first (via the existing /v1/admin/learning routes) — the approval artifact
 * must exist before an adoption can be recorded (invariant 8).
 *
 * With `retention`, the adoption also lands an AL8.4 retention-ledger row —
 * markApplied runs FIRST, so an unapproved merge writes no retention row.
 */
export function recordHumanMerge(
  store: Pick<PipelineDeps['store'], 'markApplied'>,
  proposalId: string,
  retention?: {
    ledger: { recordAdoption(rec: AdoptionRecord): unknown };
    adoption: Omit<AdoptionRecord, 'proposalId'>;
  },
): void {
  store.markApplied(proposalId);
  if (retention) {
    retention.ledger.recordAdoption({ proposalId, ...retention.adoption });
  }
  log.info({ proposalId, retained: Boolean(retention) }, 'improvement adoption recorded (human-merged + approved)');
}
