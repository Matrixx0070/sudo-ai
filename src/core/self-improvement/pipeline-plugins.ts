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

const MAX_PROMPT_CHARS = 20_000;

/** Prompt artifacts: bounded text that must clear the injected injection scan. */
export function promptPlugin(deps: {
  /** Injection scanner seam (e.g. memory/injection-scanner scanMemoryContent). */
  scan?: (text: string) => { ok: boolean; detail: string };
}): ArtifactPlugin {
  return {
    type: 'prompt',
    async validate(draft: ImprovementDraft) {
      const text = draft.payload;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, detail: 'prompt payload must be a non-empty string' };
      }
      if (text.length > MAX_PROMPT_CHARS) {
        return { ok: false, detail: `prompt exceeds ${MAX_PROMPT_CHARS} chars (${text.length})` };
      }
      if (!deps.scan) {
        return { ok: false, detail: 'no injection scanner wired — an unscanned prompt is unvalidated (fail-closed)' };
      }
      return deps.scan(text);
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
