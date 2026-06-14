/**
 * @file run-workflow.ts
 * @description meta.run-workflow — deterministic multi-step workflow runner (gap #24).
 *
 * Slice 1 (PR #122) wired the latent Lobster engine: sequential shell + tool
 * steps, `{{prev}}` stdout threading, `condition`, `approval`, opt-in via
 * SUDO_WORKFLOWS=1.
 *
 * Slice 2 (PR #134) added:
 *   - `parallel_group` — consecutive steps sharing the label fan out, bounded
 *     by `SUDO_WORKFLOWS_MAX_PARALLEL` (default 4). One failing group member
 *     halts the workflow after the rest of the group settles.
 *   - `{{steps.<id>.<field>}}` templating in `command` and `stdin` (fields:
 *     stdout, stderr, exitCode, status, durationMs). The rendered shell
 *     command + stdin are re-validated against the shell-metachar guard so an
 *     untrusted step output can't inject `$()` / backtick / pipe.
 *   - On-disk SHA-256-fingerprinted resume journal at
 *     `<DATA_DIR>/workflow-runs/<runId>.json` (override with `journal_dir`).
 *     A resume call passes `resume_run_id`; the engine refuses if the workflow
 *     source SHA-256 has changed since the journal was written.
 *
 * Slice 3 (this file) adds:
 *   - `phase` — named synchronization barriers. Consecutive steps sharing a
 *     `phase` value form a phase block; ALL members fan out concurrently into
 *     the same worker pool used by `parallel_group`, with a hard barrier at
 *     the phase boundary. Phase and parallel_group are mutually exclusive on
 *     the same step (each step picks one fan-out scope). `{{prev}}` and
 *     `approval: true` are forbidden inside a phase for the same reason as
 *     inside a parallel_group.
 *
 * Trust posture mirrors meta.ptc: `requiresConfirmation: true` on the OUTER call
 * so the operator approves running the whole workflow (whose step commands / tool
 * args they may not have authored) before any step executes.
 *
 * Opt-in: cli.ts registers this only when SUDO_WORKFLOWS=1. When the flag is OFF
 * the tool is not in the registry at all.
 *
 * Deferred (slice 4): wiring the orchestration/ TaskQueue + TaskExecutor as a
 * cross-workflow scheduler — slices 2 + 3 fan-out is intra-process for one
 * workflow run, and inter-workflow scheduling is a semantic shift (persistent
 * SQLite queue, separate handler model) that warrants its own slice.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { clampToolOutput } from '../../../shared/head-tail-buffer.js';
import { WORKSPACE_DIR, DATA_DIR } from '../../../shared/paths.js';
import { loadWorkflow, runWorkflow } from '../../../workflows/lobster.js';
import type {
  Workflow,
  WorkflowRunState,
  WorkflowStep,
  WorkflowJournal,
  ToolStepResult,
  ToolStepExecutor,
} from '../../../workflows/lobster.js';

const logger = createLogger('meta.run-workflow');

const WORKFLOWS_BASE = path.join(WORKSPACE_DIR, 'workflows');
const DEFAULT_JOURNAL_DIR = path.join(DATA_DIR, 'workflow-runs');

/**
 * Per-engine fan-out cap for `parallel_group` and `phase` blocks (slices 2 + 3
 * share the same worker pool). Read at execute time so env changes take effect
 * without process restart. Falls back to 4 on invalid input — a kill-switch via
 * `SUDO_WORKFLOWS_MAX_PARALLEL=1` reverts to effectively-sequential behavior
 * without touching workflow files.
 */
function readMaxParallel(): number {
  const raw = process.env['SUDO_WORKFLOWS_MAX_PARALLEL'];
  if (!raw) return 4;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 4;
}

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

/** Minimal structural check that a value is a resume journal we wrote. */
function isJournal(v: unknown): v is WorkflowJournal {
  if (!v || typeof v !== 'object') return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j['runId'] === 'string' &&
    typeof j['sourceSha256'] === 'string' &&
    j['version'] === 1 &&
    isRunState(j['state'])
  );
}

/** Read + parse a journal file. Returns null when missing, throws on malformed. */
async function loadJournal(journalPath: string): Promise<WorkflowJournal | null> {
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`journal "${journalPath}" is not valid JSON: ${String(err)}`);
  }
  if (!isJournal(parsed)) {
    throw new Error(`journal "${journalPath}" is missing required fields`);
  }
  return parsed;
}

/** Hex SHA-256 of the workflow source bytes. */
function sha256(buf: string): string {
  return createHash('sha256').update(buf, 'utf8').digest('hex');
}

/** Compose a stable journal filename from runId. */
function journalFile(dir: string, runId: string): string {
  return path.join(dir, `${runId}.json`);
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
    "'workflows/' directory. Steps run sequentially by default; consecutive steps sharing a " +
    "`parallel_group` label fan out (capped by SUDO_WORKFLOWS_MAX_PARALLEL, default 4), and " +
    "consecutive steps sharing a `phase` label form a named barrier block where all members " +
    'fan out concurrently and the next phase cannot start until every member settles ' +
    "(parallel_group and phase are mutually exclusive on the same step). " +
    "`stdin: '{{prev}}'` pipes the previous step's stdout; `{{steps.<id>.<field>}}` templates " +
    'in command/stdin reference any prior step (fields: stdout, stderr, exitCode, status, ' +
    'durationMs); `condition` skips; `approval: true` pauses and returns a resume token. ' +
    'Step types: `shell` (ONE argv command, no pipes) and `tool` (step.command = a host tool ' +
    'name, args = a JSON object in `stdin`) — every tool step is routed through the normal ' +
    'permission/approval gates. Set auto_approve:true to clear internal approval gates, or ' +
    'pass resume_state (from a paused run) or resume_run_id (resumes from the on-disk journal, ' +
    'verifying the source SHA-256) to continue.',
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
        'with the same file — to resume execution from where the workflow paused. Prefer ' +
        'resume_run_id when a journal_dir was used: it round-trips through a small id, not the ' +
        'whole state, and the engine verifies the source hash on disk.',
    },
    journal_dir: {
      type: 'string',
      description:
        'Directory the engine rewrites a per-run resume journal into after every settled step. ' +
        'A relative path is rejected; an absolute path is used as-is. Defaults to ' +
        '<DATA_DIR>/workflow-runs/. Pass an empty string to disable.',
    },
    resume_run_id: {
      type: 'string',
      description:
        'Resume the run with this id from disk (<journal_dir>/<run_id>.json). The engine ' +
        'refuses to resume when the SHA-256 of the workflow source has changed since the ' +
        'journal was written.',
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
    let sourceText: string;
    try {
      sourceText = await readFile(resolved, 'utf8');
    } catch (err) {
      return {
        success: false,
        output: `meta.run-workflow: cannot read "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const sourceHash = sha256(sourceText);

    try {
      workflow = await loadWorkflow(resolved);
    } catch (err) {
      return {
        success: false,
        output: `meta.run-workflow: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Resolve journal directory. Default is on; empty string disables. Any
    // user-supplied absolute path is confined to DATA_DIR or WORKSPACE_DIR so
    // a caller can't trick the engine into rewriting a journal file into
    // /etc/, /root/, ~/.ssh/, etc. The runId is also regex-confined below so
    // path traversal via `runId="../../foo"` is blocked even before this point.
    const rawJournalDir = params['journal_dir'];
    let journalDir: string | undefined;
    if (rawJournalDir === undefined || rawJournalDir === null) {
      journalDir = DEFAULT_JOURNAL_DIR;
    } else if (typeof rawJournalDir === 'string') {
      const trimmed = rawJournalDir.trim();
      if (trimmed === '') {
        journalDir = undefined;
      } else if (!path.isAbsolute(trimmed)) {
        return {
          success: false,
          output: 'meta.run-workflow: journal_dir must be an absolute path or empty',
        };
      } else {
        const normalized = path.resolve(trimmed);
        const dataRoot = path.resolve(DATA_DIR);
        const workspaceRoot = path.resolve(WORKSPACE_DIR);
        const insideData =
          normalized === dataRoot || normalized.startsWith(dataRoot + path.sep);
        const insideWorkspace =
          normalized === workspaceRoot || normalized.startsWith(workspaceRoot + path.sep);
        if (!insideData && !insideWorkspace) {
          return {
            success: false,
            output:
              `meta.run-workflow: journal_dir "${trimmed}" must be inside DATA_DIR ` +
              `(${dataRoot}) or WORKSPACE_DIR (${workspaceRoot})`,
          };
        }
        journalDir = normalized;
      }
    } else {
      return { success: false, output: 'meta.run-workflow: journal_dir must be a string' };
    }

    // If a resume_run_id was passed, load the journal off disk. The journal's
    // run state overrides any resume_state passed by the model (disk is the
    // source of truth across crashes). SHA mismatch is fatal — the workflow
    // file was edited since pause, so step semantics are no longer guaranteed.
    const resumeRunId = typeof params['resume_run_id'] === 'string' ? (params['resume_run_id'] as string).trim() : '';
    if (resumeRunId !== '') {
      if (!journalDir) {
        return {
          success: false,
          output: 'meta.run-workflow: resume_run_id requires a journal_dir (got empty)',
        };
      }
      // Refuse path traversal in run id — must be a plain uuid-ish token.
      if (!/^[A-Za-z0-9_-]+$/.test(resumeRunId)) {
        return { success: false, output: 'meta.run-workflow: resume_run_id is malformed' };
      }
      let journal: WorkflowJournal | null;
      try {
        journal = await loadJournal(journalFile(journalDir, resumeRunId));
      } catch (err) {
        return {
          success: false,
          output: `meta.run-workflow: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!journal) {
        return {
          success: false,
          output: `meta.run-workflow: no journal at ${journalFile(journalDir, resumeRunId)}`,
        };
      }
      if (journal.sourceSha256 !== sourceHash) {
        return {
          success: false,
          output:
            'meta.run-workflow: refusing to resume — workflow source SHA-256 changed since the ' +
            `journal was written (journal=${journal.sourceSha256.slice(0, 12)}…, current=${sourceHash.slice(0, 12)}…)`,
        };
      }
      if (journal.state.workflowName !== workflow.name) {
        return {
          success: false,
          output: `meta.run-workflow: journal workflow name "${journal.state.workflowName}" does not match "${workflow.name}"`,
        };
      }
      resumeState = journal.state;
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

    // Filename anchor: resumed runId on resume; else mint one here so the
    // first journal write lands at <dir>/<runId>.json (not <dir>/pending.json).
    const { randomUUID: cryptoRandomUUID } = await import('node:crypto');
    const effectiveRunId = resumeState?.runId ?? (resumeRunId !== '' ? resumeRunId : cryptoRandomUUID());
    const finalJournalPath = journalDir ? journalFile(journalDir, effectiveRunId) : undefined;

    let finalState: WorkflowRunState;
    try {
      finalState = await runWorkflow(workflow, {
        toolExecutor,
        approvalCallback,
        maxParallel: readMaxParallel(),
        runId: effectiveRunId,
        ...(resumeState ? { resumeState } : {}),
        ...(finalJournalPath ? { journalPath: finalJournalPath } : {}),
        sourceSha256: sourceHash,
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
      const resumeHint = finalJournalPath
        ? `resume_run_id: "${effectiveRunId}" (journal at ${finalJournalPath})`
        : 'resume_state set to the object in data.runState';
      parts.push(
        `\nPAUSED at approval gate (step index ${finalState.pendingStepIndex}). To continue, call ` +
          `meta.run-workflow again with the same file plus ${resumeHint} ` +
          '(or pass auto_approve:true to clear approval gates).',
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
        runId: effectiveRunId,
        ...(finalJournalPath ? { journalPath: finalJournalPath } : {}),
        // Surface only a short prefix of the source SHA-256 in the tool
        // response (the full hash is persisted in the journal). The prefix is
        // enough for an operator to spot-check correlation between a pause and
        // a resume; the full hash would act as a hash oracle for partial-file
        // edits without filesystem access.
        sourceSha256Prefix: sourceHash.slice(0, 12),
        runState: finalState,
        truncated,
      },
    };
  },
};
