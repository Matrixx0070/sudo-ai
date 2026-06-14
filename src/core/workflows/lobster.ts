/**
 * @file workflows/lobster.ts
 * @description Lobster-style deterministic workflow engine for SUDO-AI.
 *
 * Pipelines are defined in YAML files (.lobster.yaml). Steps run sequentially;
 * stdout is threaded between steps via `stdin: '{{prev}}'`; approval gates
 * can pause execution and return a resumeToken for out-of-band continuation.
 *
 * Re-exports all public types from ./types.ts so consumers only need to import
 * from this single entry point.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'node:path';
import { parseYaml } from './yaml-parser.js';
import {
  validateWorkflow,
  evaluateCondition,
  execShell,
  renderTemplate,
  assertRenderedCommandSafe,
} from './executor.js';
import type { AccessorMap } from './executor.js';
import { createLogger } from '../shared/logger.js';
import { WORKSPACE_DIR } from '../shared/paths.js';

const log = createLogger('workflows');

// ---------------------------------------------------------------------------
// Path confinement — workflows must live under WORKFLOWS_BASE
// ---------------------------------------------------------------------------

const WORKFLOWS_BASE = path.join(WORKSPACE_DIR, 'workflows');

/**
 * Resolve a step's stdin by running the template engine (`{{prev}}` and
 * `{{steps.<id>.<field>}}`). Shared by shell and tool step execution.
 *
 * When the result expanded ANY token AND the step is shell-typed, the caller
 * re-validates against the shell-metachar guard; tool stdin is JSON and never
 * reaches a shell.
 */
function resolveStdin(
  step: WorkflowStep,
  completedSteps: StepResult[],
): { value: string | undefined; expanded: boolean } {
  if (step.stdin === undefined) return { value: undefined, expanded: false };
  const { rendered, expanded } = renderTemplate(step.stdin, completedSteps);
  return { value: rendered, expanded };
}

// ---------------------------------------------------------------------------
// Resume journal — on-disk SHA-256-fingerprinted run state (slice 2)
// ---------------------------------------------------------------------------

/**
 * Atomically rewrite the journal file. Uses fs.rename which is atomic on the
 * same filesystem — readers either see the previous snapshot or the new one,
 * never a torn write. Failures are non-fatal: log + continue so a full disk
 * doesn't kill an in-progress workflow run; the in-memory state is the source
 * of truth, the journal is for crash recovery only.
 */
async function writeJournal(
  journalPath: string,
  payload: WorkflowJournal,
): Promise<void> {
  try {
    await mkdir(path.dirname(journalPath), { recursive: true });
    const tmp = `${journalPath}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, journalPath);
  } catch (err) {
    log.warn(
      { journalPath, err: err instanceof Error ? err.message : String(err) },
      'writeJournal failed — in-memory state retained',
    );
  }
}

// ---------------------------------------------------------------------------
// Re-export all public types so downstream consumers only import from here
// ---------------------------------------------------------------------------

export type {
  WorkflowStep,
  Workflow,
  StepResult,
  WorkflowRunState,
  RunOptions,
  ToolStepResult,
  ToolStepExecutor,
  WorkflowJournal,
} from './types.js';

import type {
  WorkflowStep,
  Workflow,
  StepResult,
  WorkflowRunState,
  RunOptions,
  ToolStepResult,
  WorkflowJournal,
} from './types.js';

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

/**
 * Load and parse a workflow YAML file.
 *
 * @param filePath - Path to the .lobster.yaml file.
 * @param options  - Optional overrides. `basePath` is ONLY for tests.
 * @returns Parsed and validated Workflow object.
 * @throws On file read errors, YAML parse failures, or validation violations.
 */
export async function loadWorkflow(
  filePath: string,
  options?: { basePath?: string },
): Promise<Workflow> {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('loadWorkflow: filePath must be a non-empty string');
  }

  // Enforce path confinement — resolved path must be inside the base directory
  const base = options?.basePath !== undefined
    ? path.resolve(options.basePath)
    : WORKFLOWS_BASE;
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(
      `loadWorkflow: path "${filePath}" is outside the allowed base directory`,
    );
  }

  if (!resolved.endsWith('.yaml')) {
    throw new Error(
      `loadWorkflow: file "${filePath}" must have a .yaml or .lobster.yaml extension`,
    );
  }

  log.info({ filePath }, 'Loading workflow');

  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`loadWorkflow: cannot read file "${filePath}": ${String(err)}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new Error(`loadWorkflow: YAML parse error in "${filePath}": ${String(err)}`);
  }

  const workflow: Workflow = {
    name: String(raw['name'] ?? ''),
    description: raw['description'] !== undefined ? String(raw['description']) : undefined,
    steps: [],
  };

  const rawSteps = raw['steps'];
  if (Array.isArray(rawSteps)) {
    for (const s of rawSteps) {
      const rs = s as Record<string, unknown>;
      const step: WorkflowStep = {
        id: String(rs['id'] ?? ''),
        command: String(rs['command'] ?? ''),
        type: (rs['type'] as 'shell' | 'tool' | undefined) ?? 'shell',
        stdin: rs['stdin'] !== undefined ? String(rs['stdin']) : undefined,
        approval: rs['approval'] === true || rs['approval'] === 'true',
        condition: rs['condition'] !== undefined ? String(rs['condition']) : undefined,
        timeout: rs['timeout'] !== undefined ? Number(rs['timeout']) : undefined,
        parallel_group:
          rs['parallel_group'] !== undefined ? String(rs['parallel_group']) : undefined,
        phase: rs['phase'] !== undefined ? String(rs['phase']) : undefined,
      };
      workflow.steps.push(step);
    }
  }

  validateWorkflow(workflow);

  log.info({ workflowName: workflow.name, stepCount: workflow.steps.length }, 'Workflow loaded');
  return workflow;
}

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

/**
 * Execute a workflow sequentially, optionally resuming from a saved state.
 *
 * Steps are executed in order. On a failing step (non-zero exit code) the
 * engine halts and returns the current state. On an approval gate the engine
 * either invokes `approvalCallback` or pauses immediately, returning a state
 * with `resumeToken` and `pendingStepIndex` set.
 *
 * @param workflow - Parsed Workflow object.
 * @param options  - Optional resume state and approval callback.
 * @returns Final WorkflowRunState capturing all step results.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: RunOptions = {},
): Promise<WorkflowRunState> {
  const { resumeState, approvalCallback, toolExecutor, journalPath, sourceSha256 } = options;
  const maxParallel = Math.max(1, options.maxParallel ?? 4);

  if (journalPath !== undefined && !sourceSha256) {
    throw new Error('runWorkflow: journalPath requires sourceSha256');
  }

  const runState: WorkflowRunState = resumeState
    ? {
        ...resumeState,
        // Drop the awaiting_approval placeholder recorded at pause time so the
        // resumed step re-executes cleanly: {{prev}} then resolves to the last
        // genuinely-completed step (not the stdout-less approval entry) and no
        // duplicate StepResult is appended for the resumed step.
        completedSteps: resumeState.completedSteps.filter((s) => s.status !== 'awaiting_approval'),
        pendingStepIndex: undefined,
        pendingStepId: undefined,
        resumeToken: undefined,
      }
    : {
        workflowName: workflow.name,
        startedAt: new Date().toISOString(),
        completedSteps: [],
      };

  /** Per-run journal id — stable across writes for a single run. */
  const runId = resumeState?.runId ?? options.runId ?? randomUUID();
  runState.runId = runId;

  const persist = async (): Promise<void> => {
    if (!journalPath || !sourceSha256) return;
    await writeJournal(journalPath, {
      runId,
      sourceSha256,
      version: 1,
      state: runState,
    });
  };

  const startIndex = resumeState?.pendingStepIndex ?? 0;

  /** Build the accessor map used by the condition evaluator. */
  function buildStepsMap(): AccessorMap {
    const inner: Record<string, StepResult> = {};
    for (const r of runState.completedSteps) {
      inner[r.id] = r;
    }
    return { steps: inner };
  }

  log.info(
    {
      workflowName: workflow.name,
      startIndex,
      stepCount: workflow.steps.length,
      maxParallel,
      journal: journalPath !== undefined,
    },
    'Running workflow',
  );

  // ---------------------------------------------------------------------
  // Step-execution kernel — runs ONE step. Returns the StepResult; the
  // caller appends it to runState in serialized order. No condition / no
  // approval checks here — those are handled by the outer scheduler before
  // a step is even submitted, because they read runState and would race
  // against parallel siblings.
  // ---------------------------------------------------------------------
  async function executeStep(step: WorkflowStep): Promise<StepResult> {
    const t0 = Date.now();

    if (step.type === 'tool') {
      if (!toolExecutor) {
        log.warn({ stepId: step.id }, 'Tool step with no executor — failing honestly');
        return {
          id: step.id,
          status: 'failure',
          stdout: '',
          stderr: 'tool-type step requires a tool executor; run this workflow via meta.run-workflow',
          exitCode: 1,
          durationMs: Date.now() - t0,
        };
      }

      const { value: toolStdin } = resolveStdin(step, runState.completedSteps);
      let outcome: ToolStepResult;
      try {
        outcome = await toolExecutor(step, toolStdin);
      } catch (err) {
        outcome = { success: false, stderr: err instanceof Error ? err.message : String(err) };
      }
      return {
        id: step.id,
        status: outcome.success ? 'success' : 'failure',
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        exitCode: outcome.success ? 0 : 1,
        durationMs: Date.now() - t0,
      };
    }

    // Shell step: render command + stdin against completed-step results, then
    // re-validate against the shell-metachar guards. Untrusted step output
    // that injects `$()` / backtick / pipe halts the run honestly.
    let renderedCommand = step.command;
    try {
      const cmdRender = renderTemplate(step.command, runState.completedSteps);
      renderedCommand = cmdRender.rendered;
      if (cmdRender.expanded) assertRenderedCommandSafe(step.id, renderedCommand);
    } catch (err) {
      return {
        id: step.id,
        status: 'failure',
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: Date.now() - t0,
      };
    }

    // Note: stdin is a pipe to the child, not a shell — the load-time
    // STDIN_DANGEROUS_RE check explicitly exempts `{{prev}}` for the same
    // reason. We do NOT re-validate rendered stdin; arbitrary bytes from a
    // prior step's stdout (including newlines) are intended to flow through.
    const stdinRender = resolveStdin(step, runState.completedSteps);
    const stdinData = stdinRender.value;

    log.info({ stepId: step.id, command: renderedCommand }, 'Executing step');

    const { stdout, stderr, exitCode } = await execShell(renderedCommand, stdinData, step.timeout);
    return {
      id: step.id,
      status: exitCode === 0 ? 'success' : 'failure',
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------
  // Fan-out block executor (shared by parallel_group AND phase). Members all
  // settle before this returns, with a hard barrier at the boundary. One
  // failing member halts the workflow AFTER the rest of the block settles —
  // partial-result visibility beats noisy aborts.
  //
  // Returns true if the workflow should halt (a member failed); the caller
  // returns runState immediately on true.
  // ---------------------------------------------------------------------
  const runFanOutBlock = async (
    members: WorkflowStep[],
    label: { kind: 'parallel_group' | 'phase'; value: string },
  ): Promise<boolean> => {
    log.info(
      {
        workflowName: workflow.name,
        [label.kind]: label.value,
        members: members.length,
        maxParallel,
      },
      `Running ${label.kind}`,
    );

    // Pre-skip members whose `condition` is false (gates read pre-block state,
    // exactly like sequential). Survivors go into the dispatch pool. Skipped
    // members land in a Map keyed by id so the source-order append loop below
    // stays O(n) regardless of skip count — future-proofing the engine for
    // large phase blocks where every member could fail the condition gate.
    const dispatchable: WorkflowStep[] = [];
    const skipResults = new Map<string, StepResult>();
    for (const s of members) {
      if (s.condition) {
        const pass = evaluateCondition(s.condition, buildStepsMap());
        if (!pass) {
          skipResults.set(s.id, { id: s.id, status: 'skipped', durationMs: 0 });
          continue;
        }
      }
      dispatchable.push(s);
    }

    // Semaphore-bounded fan-out. We don't use Promise.all on a fixed pool
    // because the cap may be smaller than the block size. The simple
    // worker-pool pattern below preserves member submission order under cap
    // while keeping the implementation tight.
    const results = new Map<string, StepResult>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < dispatchable.length) {
        const idx = cursor++;
        const member = dispatchable[idx]!;
        const r = await executeStep(member);
        results.set(member.id, r);
        log.info(
          {
            stepId: r.id,
            status: r.status,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            [label.kind]: label.value,
          },
          `${label.kind} member completed`,
        );
      }
    };
    const poolSize = Math.min(maxParallel, dispatchable.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    // Append results in the original member order so {{prev}} (after the
    // block) and the journal observe a deterministic sequence.
    for (const s of members) {
      const r = skipResults.get(s.id) ?? results.get(s.id);
      if (r) runState.completedSteps.push(r);
    }
    await persist();

    const blockFailed = members.some((s) => {
      const r = results.get(s.id);
      return r && r.status === 'failure';
    });
    if (blockFailed) {
      log.warn(
        { workflowName: workflow.name, [label.kind]: label.value },
        `${label.kind} had a failing member — halting workflow`,
      );
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------
  // Block-aware scheduler. Walks the step list, classifying each position
  // as one of three block types and dispatching accordingly:
  //   - solo:           sequential semantics (condition + approval + execute)
  //   - parallel_group: slice 2 fan-out across consecutive same-group peers
  //   - phase:          slice 3 named fan-out across consecutive same-phase
  //                     members, with a hard barrier at the phase boundary
  // ---------------------------------------------------------------------
  let i = startIndex;
  while (i < workflow.steps.length) {
    const first = workflow.steps[i] as WorkflowStep;

    // Phase block takes precedence — validateStep guarantees a step cannot
    // have BOTH phase and parallel_group, so the check order is safe.
    if (first.phase !== undefined) {
      const phaseLabel = first.phase;
      const phaseSteps: WorkflowStep[] = [];
      let j = i;
      while (j < workflow.steps.length) {
        const s = workflow.steps[j] as WorkflowStep;
        if (s.phase !== phaseLabel) break;
        phaseSteps.push(s);
        j++;
      }
      const halt = await runFanOutBlock(phaseSteps, { kind: 'phase', value: phaseLabel });
      if (halt) return runState;
      i = j;
      continue;
    }

    if (first.parallel_group !== undefined) {
      const groupLabel = first.parallel_group;
      const groupSteps: WorkflowStep[] = [];
      let j = i;
      while (j < workflow.steps.length) {
        const s = workflow.steps[j] as WorkflowStep;
        if (s.parallel_group !== groupLabel) break;
        groupSteps.push(s);
        j++;
      }
      const halt = await runFanOutBlock(groupSteps, { kind: 'parallel_group', value: groupLabel });
      if (halt) return runState;
      i = j;
      continue;
    }

    // Solo step — sequential semantics (condition + approval + execute).
    if (first.condition) {
      const pass = evaluateCondition(first.condition, buildStepsMap());
      if (!pass) {
        log.info({ stepId: first.id, condition: first.condition }, 'Step skipped (condition false)');
        runState.completedSteps.push({ id: first.id, status: 'skipped', durationMs: 0 });
        await persist();
        i++;
        continue;
      }
    }

    if (first.approval) {
      log.info({ stepId: first.id }, 'Step requires approval');
      let approved = false;
      if (approvalCallback) {
        approved = await approvalCallback(first, runState);
      }
      if (!approved) {
        const token = randomUUID();
        runState.pendingStepIndex = i;
        runState.pendingStepId = first.id;
        runState.resumeToken = token;
        runState.completedSteps.push({ id: first.id, status: 'awaiting_approval', durationMs: 0 });
        await persist();
        log.info({ stepId: first.id, resumeToken: token }, 'Workflow paused — awaiting approval');
        return runState;
      }
      log.info({ stepId: first.id }, 'Approval granted — continuing');
    }

    const result = await executeStep(first);
    log.info(
      { stepId: result.id, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs },
      'Step completed',
    );
    runState.completedSteps.push(result);
    await persist();

    if (result.status === 'failure') {
      log.warn({ stepId: result.id, exitCode: result.exitCode }, 'Step failed — halting workflow');
      return runState;
    }
    i++;
  }

  await persist();
  return runState;
}
