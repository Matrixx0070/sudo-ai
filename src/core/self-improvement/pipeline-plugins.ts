/**
 * @file self-improvement/pipeline-plugins.ts
 * @description AL8.2 artifact-type plugins for the uniform improvement
 * pipeline — each owns HOW its artifact type is validated; the pipeline
 * enforces THAT validation happens. All plugins fail closed on missing
 * capability rather than waving artifacts through:
 *
 *   prompt         — size + non-empty + injected injection-scan (a prompt IS
 *                    model-facing text; unscanned = unvalidated)
 *   workflow-graph — the REAL graph validators (validateGraph +
 *                    validateGraphRoutes) — the AL3 engine's own load-time
 *                    contract is the validation
 *   tool           — refuses until AL8.3 lands the skill-package delivery
 *                    vehicle (honest unsupported, not a stub pass)
 *   code-patch     — requires an injected sandbox validator (trust-tier);
 *                    none wired = held, per the Campaign-4 sandbox gap
 */

import { validateGraph, validateGraphRoutes, type WorkflowGraph } from '../workflows/index.js';
import type { ArtifactPlugin, ImprovementDraft } from './pipeline.js';
import {
  CURRENT_MANIFEST,
  findWeakenings,
  isVersionIncrease,
  validateManifest,
  type PipelineManifest,
} from './pipeline-manifest.js';

const MAX_PROMPT_CHARS = 20_000;

/** Prompt artifacts: bounded text that must clear the injected injection scan. */
export function promptPlugin(deps: {
  /** Injection scanner seam (e.g. memory/injection-scanner scanMemoryContent). */
  scan?: (text: string) => { ok: boolean; detail: string };
  /** AL9.1: bars read from the pinned manifest (default CURRENT — unchanged behavior). */
  manifest?: PipelineManifest;
}): ArtifactPlugin {
  const m = deps.manifest ?? CURRENT_MANIFEST;
  const maxChars = m.validators.maxPromptChars ?? MAX_PROMPT_CHARS;
  return {
    type: 'prompt',
    async validate(draft: ImprovementDraft) {
      const text = draft.payload;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, detail: 'prompt payload must be a non-empty string' };
      }
      if (text.length > maxChars) {
        return { ok: false, detail: `prompt exceeds ${maxChars} chars (${text.length}) — bar from manifest ${m.version}` };
      }
      if (m.validators.requireInjectionScan && !deps.scan) {
        return { ok: false, detail: 'no injection scanner wired — an unscanned prompt is unvalidated (fail-closed)' };
      }
      return deps.scan ? deps.scan(text) : { ok: true, detail: 'scan waived by manifest (human-authored manifest change)' };
    },
  };
}

// ---------------------------------------------------------------------------
// AL9.2 meta-artifact: pipeline-change
// ---------------------------------------------------------------------------

/** Payload shape for AL9.2 meta-proposals — a full candidate manifest + evidence. */
export interface PipelineChangePayload {
  targetManifest: PipelineManifest;
  evidence: {
    /** Retention-ledger proposal ids the change cites — must EXIST. */
    retentionProposalIds: string[];
    summary: string;
  };
}

/**
 * AL9.2: the system may propose changes to its OWN pipeline manifest — with
 * strictly MORE gating than any other artifact:
 *   - SUDO_AL_META=1 required (default OFF — AL9.6 rung gate, fail-closed);
 *   - target must be a STRICT semver increase over the running manifest;
 *   - the never-weaken rule is structural: a machine proposal that lowers
 *     bars, drops eval suites, or loosens validators is REFUSED — weakening
 *     is a human-authored PR only (AL9.4);
 *   - evidence must cite ≥1 retention-ledger row that actually exists
 *     (AL9.3 lineage: manifest changes argue from recorded outcomes);
 *   - meta-proposals are ALWAYS human-merged. No auto-merge class exists for
 *     pipeline-change, ever — and the pipeline itself has no merge capability.
 */
export function pipelineChangePlugin(deps: {
  /** Retention-ledger read surface (evidence verification). */
  retention?: { getByProposalId(proposalId: string): unknown | undefined };
  /** The running manifest (default CURRENT_MANIFEST). */
  base?: PipelineManifest;
} = {}): ArtifactPlugin {
  return {
    type: 'pipeline-change',
    async validate(draft: ImprovementDraft) {
      if (process.env['SUDO_AL_META'] !== '1') {
        return { ok: false, detail: 'AL9 meta-proposals are gated OFF (SUDO_AL_META != 1) — rung not activated (AL9.6)' };
      }
      const base = deps.base ?? CURRENT_MANIFEST;
      const p = draft.payload as Partial<PipelineChangePayload> | undefined;
      if (!p?.targetManifest || !p.evidence) {
        return { ok: false, detail: 'pipeline-change payload must be { targetManifest, evidence }' };
      }
      try {
        validateManifest(p.targetManifest as PipelineManifest);
      } catch (err) {
        return { ok: false, detail: `target manifest invalid: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!isVersionIncrease(base.version, p.targetManifest.version)) {
        return { ok: false, detail: `target version ${p.targetManifest.version} is not a strict increase over running ${base.version}` };
      }
      const weakenings = findWeakenings(base, p.targetManifest as PipelineManifest);
      if (weakenings.length > 0) {
        return {
          ok: false,
          detail: `never-weaken: machine proposals may not weaken the pipeline (${weakenings.join('; ')}) — weakening is a human-authored PR only`,
        };
      }
      const ids = p.evidence.retentionProposalIds ?? [];
      if (ids.length === 0 || !p.evidence.summary?.trim()) {
        return { ok: false, detail: 'meta-proposals must cite retention-ledger evidence (ids + summary)' };
      }
      if (!deps.retention) {
        return { ok: false, detail: 'no retention-ledger seam wired — uncited evidence cannot be verified (fail-closed)' };
      }
      const missing = ids.filter((id) => deps.retention!.getByProposalId(id) === undefined);
      if (missing.length > 0) {
        return { ok: false, detail: `cited retention rows do not exist: ${missing.join(', ')}` };
      }
      return {
        ok: true,
        detail:
          `manifest ${base.version} → ${p.targetManifest.version} validated; ${ids.length} ledger citation(s). ` +
          'META: human merge only — no auto-merge class exists for pipeline-change, ever.',
      };
    },
  };
}

/** Workflow-graph artifacts: the AL3 engine's own validators are the check. */
export function workflowGraphPlugin(): ArtifactPlugin {
  return {
    type: 'workflow-graph',
    async validate(draft: ImprovementDraft) {
      const graph = draft.payload as WorkflowGraph;
      try {
        validateGraph(graph);
        validateGraphRoutes(graph);
        return {
          ok: true,
          detail: `graph "${graph.name}" valid (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
        };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Payload shape for AL8.3 tool artifacts — a versioned skill package draft. */
export interface ToolArtifactPayload {
  skillName: string;
  version: string;
  markdown: string;
  /** Tool categories the skill routes to — each must be in CATEGORY_MAP. */
  categories?: string[];
}

/**
 * Tool artifacts (AL8.3): the Spec-9 skill package IS the delivery vehicle —
 * validation runs the SAME SkillWorkshop gate that apply() re-runs on merge
 * (injection scan, workspace-tier capability pinning, path confinement), and
 * adoption ships as a versioned package with lockfile pin + .versions
 * rollback. The CATEGORY_MAP gotcha is a contract here: declared tool
 * categories must exist in the router map or the artifact is refused —
 * an unroutable category is a tool nobody can call.
 */
export function toolPlugin(deps: {
  /** SkillWorkshop.gate seam (validate WITHOUT applying). */
  workshopGate?: (p: { skillName: string; version: string; markdown: string }) => { ok: boolean; reasons: string[] };
  /** CATEGORY_MAP membership check (tool-router) for declared categories. */
  knownCategory?: (category: string) => boolean;
} = {}): ArtifactPlugin {
  return {
    type: 'tool',
    async validate(draft: ImprovementDraft) {
      const p = draft.payload as Partial<ToolArtifactPayload> | undefined;
      if (!p || typeof p.skillName !== 'string' || !p.skillName.trim() ||
          typeof p.version !== 'string' || !p.version.trim() ||
          typeof p.markdown !== 'string' || !p.markdown.trim()) {
        return { ok: false, detail: 'tool payload must be a skill package {skillName, version, markdown}' };
      }
      if (!deps.workshopGate) {
        return { ok: false, detail: 'no SkillWorkshop gate wired — an ungated skill package is unvalidated (fail-closed)' };
      }
      const gate = deps.workshopGate({ skillName: p.skillName, version: p.version, markdown: p.markdown });
      if (!gate.ok) {
        return { ok: false, detail: `workshop gate refused: ${gate.reasons.join('; ')}` };
      }
      const categories = p.categories ?? [];
      if (categories.length > 0) {
        if (!deps.knownCategory) {
          return { ok: false, detail: 'categories declared but no CATEGORY_MAP checker wired (fail-closed)' };
        }
        const unknown = categories.filter((c) => !deps.knownCategory!(c));
        if (unknown.length > 0) {
          return {
            ok: false,
            detail: `unroutable tool categories (missing CATEGORY_MAP entry — the textproc gotcha): ${unknown.join(', ')}`,
          };
        }
      }
      return {
        ok: true,
        detail: `skill package "${p.skillName}"@${p.version} cleared the workshop gate` +
          (categories.length ? `; categories routable: ${categories.join(', ')}` : ''),
      };
    },
  };
}

/** Code-patch artifacts: sandbox validation is mandatory, not optional. */
export function codePatchPlugin(deps: {
  /** Trust-tier sandbox validator seam (build+tests inside the sandbox). */
  sandboxValidate?: (draft: ImprovementDraft) => Promise<{ ok: boolean; detail: string }>;
}): ArtifactPlugin {
  return {
    type: 'code-patch',
    async validate(draft: ImprovementDraft) {
      if (!deps.sandboxValidate) {
        return {
          ok: false,
          detail:
            'code patches require a trust-tier sandbox validator and none is wired — ' +
            'generated code never validates on the host (Campaign-4 AL8.5 gap, fail-closed)',
        };
      }
      return deps.sandboxValidate(draft);
    },
  };
}
