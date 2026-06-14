/**
 * @file run-workflow.ts
 * @description meta.run-workflow — deterministic multi-step workflow runner (gap #24, slice 1).
 *
 * Wires the latent Lobster workflow engine (src/core/workflows/) into the tool
 * registry. A workflow is a `.yaml` file of sequential steps; the engine threads
 * stdout between steps via `stdin: '{{prev}}'`, gates steps on `condition`
 * expressions, and pauses on `approval: true` steps returning a resume token.
 *
 * Two step types:
 *   - type: shell  → runs ONE argv command (no shell, no pipes) with a per-step
 *                    timeout + 10 MB output clamp.
 *   - type: tool   → dispatches `step.command` as a host tool name with JSON args
 *                    taken from `stdin`, routed through `registry.execute()` — the
 *                    SAME permission / approval / sandbox / plan-mode gates a
 *                    normal tool call hits, NOT a privileged bypass.
 *
 * Trust posture mirrors meta.ptc: `requiresConfirmation: true` on the OUTER call
 * so the operator approves running the whole workflow (whose step commands / tool
 * args they may not have authored) before any step executes.
 *
 * Opt-in: cli.ts registers this only when SUDO_WORKFLOWS=1. When the flag is OFF
 * the tool is not in the registry at all.
 *
 * Deferred (follow-up slices): parallel()/phase() fan-out via the orchestration/
 * TaskExecutor; a SHA-256 resume journal persisted to disk (today the run state
 * round-trips through the model via the `resume_state` param); argument
 * templating from prior step outputs.
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { clampToolOutput } from '../../../shared/head-tail-buffer.js';
import { WORKSPACE_DIR } from '../../../shared/paths.js';
import { loadWorkflow, runWorkflow } from '../../../workflows/lobster.js';
import type {
  Workflow,
  WorkflowRunState,
  WorkflowStep,
  ToolStepResult,
  ToolStepExecutor,
} from '../../../workflows/lobster.js';

const logger = createLogger('meta.run-workflow');

const WORKFLOWS_BASE = path.join(WORKSPACE_DIR, 'workflows');

// ---------------------------------------------------------------------------
// Dependency injection — the ToolRegistry that `type: 'tool'` steps dispatch
// against. Set via setWorkflowRegistry() from cli.ts when SUDO_WORKFLOWS=1.
// Standalone (not the shared meta-deps map) because only this tool needs the
// registry — same pattern as meta.ptc's setPtcRegistry.
// ---------------------------------------------------------------------------

let _registry: ToolRegistry | null = null;

export function setWorkflowRegistry(registry: ToolRegistry | null): void {
  _registry = registry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject a workflow tool step that tries to re-enter the workflow runner. */
function isSelfRecursion(toolName: string): boolean {
  // Bare `run-workflow` is also rejected: Ollama strips dotted prefixes, so the
  // registry suffix-match would otherwise resolve it to `meta.run-workflow`.
  return toolName === 'meta.run-workflow' || toolName === 'run-workflow';
}

/** Minimal structural check that a value is a resumable run state. */
function isRunState(v: unknown): v is WorkflowRunState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s['workflowName'] === 'string' && Array.isArray(s['completedSteps']);
}

/** One line per completed step: `  - <id>: <status> exit=<n>`. */
function formatState(state: WorkflowRunState): string {
  return state.completedSteps
    .map((s) => {
      const code = s.exitCode !== undefined ? ` exit=${s.exitCode}` : '';
      return `  - ${s.id}: ${s.status}${code}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const runWorkflowTool: ToolDefinition = {
  name: 'meta.run-workflow',
  description:
    "Run a deterministic multi-step workflow defined in a .yaml file under the workspace " +
    "'workflows/' directory. Steps run sequentially; `stdin: '{{prev}}'` pipes the previous " +
    "step's stdout; `condition` skips a step; `approval: true` pauses and returns a resume " +
    'token. Step types: `shell` (ONE argv command, no pipes) and `tool` (step.command = a host ' +
    'tool name, args = a JSON object in `stdin`) — every tool step is routed through the normal ' +
    'permission/approval gates. Set auto_approve:true to clear internal approval gates, or pass ' +
    'resume_state (from a paused run, with the same file) to continue it.',
  category: 'meta' as const,
  safety: 'destructive',
  // The workflow's step commands / tool args may not have been authored by the
  // operator — approve running the WHOLE workflow before any step executes,
  // exactly like meta.ptc gates the whole script.
  requiresConfirmation: true,
  timeout: 600_000,
  parameters: {
    file: {
      type: 'string',
      required: true,
      description:
        "Path to the workflow .yaml file. A relative path resolves under the workspace " +
        "'workflows/' directory; absolute paths must still resolve inside it.",
    },
    auto_approve: {
      type: 'boolean',
      description:
        'When true, internal `approval: true` step gates are auto-approved (the outer ' +
        'confirmation already approved running the workflow). Default false: pause at the ' +
        'first approval gate and return a resume token.',
      default: false,
    },
    resume_state: {
      type: 'object',
      description:
        'The run-state object returned in data.runState by a prior PAUSED call. Supply it — ' +
        'with the same file — to resume execution from where the workflow paused.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = _registry;
    if (!registry) {
      return {
        success: false,
        output:
          'meta.run-workflow: tool registry has not been injected. ' +
          'cli.ts wires this when SUDO_WORKFLOWS=1.',
      };
    }

    const file = typeof params['file'] === 'string' ? (params['file'] as string).trim() : '';
    if (file === '') {
      return { success: false, output: 'meta.run-workflow: "file" must be a non-empty string' };
    }

    const autoApprove = params['auto_approve'] === true;

    // Resolve optional resume state (object or JSON string).
    let resumeState: WorkflowRunState | undefined;
    const rawResume = params['resume_state'];
    if (rawResume !== undefined && rawResume !== null && rawResume !== '') {
      let candidate: unknown = rawResume;
      if (typeof rawResume === 'string') {
        try {
          candidate = JSON.parse(rawResume);
        } catch {
          return { success: false, output: 'meta.run-workflow: resume_state is not valid JSON' };
        }
      }
      if (!isRunState(candidate)) {
        return {
          success: false,
          output: 'meta.run-workflow: resume_state is not a valid workflow run state',
        };
      }
      resumeState = candidate;
    }

    // Resolve the file: relative paths land under the workflows base; absolute
    // paths are passed through and re-checked for confinement by loadWorkflow.
    const resolved = path.isAbsolute(file) ? file : path.join(WORKFLOWS_BASE, file);

    let workflow: Workflow;
    try {
      workflow = await loadWorkflow(resolved);
    } catch (err) {
      return {
        success: false,
        output: `meta.run-workflow: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Tool-step executor: dispatch step.command through the host registry with
    // the SAME gates a normal tool call hits. Args come from the step's stdin
    // (a JSON object). Self-recursion and malformed args fail honestly.
    const toolExecutor: ToolStepExecutor = async (
      step: WorkflowStep,
      resolvedStdin: string | undefined,
    ): Promise<ToolStepResult> => {
      const toolName = step.command.trim();
      if (isSelfRecursion(toolName)) {
        return { success: false, stderr: 'meta.run-workflow cannot invoke itself' };
      }

      let args: Record<string, unknown> = {};
      if (resolvedStdin !== undefined && resolvedStdin.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(resolvedStdin);
        } catch {
          return {
            success: false,
            stderr: `tool step "${step.id}": stdin must be a JSON object of tool args`,
          };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return {
            success: false,
            stderr: `tool step "${step.id}": stdin JSON must be an object of tool args`,
          };
        }
        args = parsed as Record<string, unknown>;
      }

      try {
        const res = await registry.execute(toolName, args, ctx);
        return { success: res.success, stdout: res.output, stderr: res.success ? '' : res.output };
      } catch (err) {
        return { success: false, stderr: err instanceof Error ? err.message : String(err) };
      }
    };

    // Resuming a paused run implies approval of the step it paused on; any
    // LATER approval gate still pauses (unless auto_approve clears everything).
    // Match on the stable pendingStepId (id, not index) so an edit to the
    // workflow file between pause and resume can't auto-approve the wrong step;
    // fall back to the index for run states written before pendingStepId existed.
    const resumedStepId =
      resumeState?.pendingStepId ??
      (resumeState && typeof resumeState.pendingStepIndex === 'number'
        ? workflow.steps[resumeState.pendingStepIndex]?.id
        : undefined);

    const approvalCallback = async (
      step: WorkflowStep,
      _runState: WorkflowRunState,
    ): Promise<boolean> => {
      if (autoApprove) return true;
      if (resumedStepId !== undefined && step.id === resumedStepId) return true;
      return false;
    };

    logger.info(
      {
        sessionId: ctx.sessionId,
        workflow: workflow.name,
        steps: workflow.steps.length,
        autoApprove,
        resuming: resumeState !== undefined,
      },
      'Running workflow',
    );

    let finalState: WorkflowRunState;
    try {
      finalState = await runWorkflow(workflow, {
        toolExecutor,
        approvalCallback,
        ...(resumeState ? { resumeState } : {}),
      });
    } catch (err) {
      return {
        success: false,
        output: `meta.run-workflow: execution error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const paused = finalState.resumeToken !== undefined;
    const failed = finalState.completedSteps.some((s) => s.status === 'failure');

    const parts: string[] = [
      `workflow "${workflow.name}" — ${finalState.completedSteps.length} step(s):`,
      formatState(finalState),
    ];
    if (paused) {
      parts.push(
        `\nPAUSED at approval gate (step index ${finalState.pendingStepIndex}). To continue, call ` +
          'meta.run-workflow again with the same file plus resume_state set to the object in ' +
          'data.runState (or pass auto_approve:true to clear approval gates).',
      );
    } else if (failed) {
      parts.push('\nWorkflow halted on a failing step.');
    } else {
      parts.push('\nWorkflow completed.');
    }

    const { text: output, truncated } = clampToolOutput(parts.join('\n'));

    // A pause is a legitimate non-error outcome (success = no failing step).
    return {
      success: !failed,
      output,
      data: {
        workflowName: finalState.workflowName,
        completed: !paused && !failed,
        paused,
        failed,
        resumeToken: finalState.resumeToken,
        pendingStepIndex: finalState.pendingStepIndex,
        runState: finalState,
        truncated,
      },
    };
  },
};
