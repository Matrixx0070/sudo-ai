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

/** Tool artifacts: refused until the AL8.3 skill-package vehicle exists. */
export function toolPlugin(): ArtifactPlugin {
  return {
    type: 'tool',
    async validate() {
      return {
        ok: false,
        detail:
          'tool artifact delivery lands with AL8.3 (versioned skill package + capability-registry entry); ' +
          'the pipeline refuses tool artifacts until that vehicle exists — no unvalidated registration path',
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
