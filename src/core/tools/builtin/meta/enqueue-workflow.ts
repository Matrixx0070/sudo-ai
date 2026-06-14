/**
 * @file enqueue-workflow.ts
 * @description meta.enqueue-workflow — async / persistent workflow scheduler
 * (gap #24 slice 4).
 *
 * Slice 1 (PR #122) wired the latent Lobster engine sequentially.
 * Slice 2 (PR #134) added parallel_group fan-out, {{steps.<id>.<field>}}
 * templating, and the on-disk SHA-256 resume journal.
 * Slice 3 (PR #135) added phase synchronization barriers.
 *
 * Slice 4 (this file) wires the orchestration/ TaskQueue + TaskExecutor as a
 * CROSS-workflow scheduler:
 *   - Workflow runs are persisted to `<DATA_DIR>/mind.db`.
 *   - Up to `SUDO_WORKFLOWS_QUEUE_CONCURRENT` runs execute concurrently
 *     (default 2; each run still uses SUDO_WORKFLOWS_MAX_PARALLEL for its OWN
 *     intra-workflow fan-out — the two caps multiply).
 *   - Pending runs survive process restarts (TaskExecutor drains 'queued'
 *     tasks on start).
 *   - Queued runs auto-approve internal `approval: true` gates. This tool
 *     REFUSES to enqueue a workflow that contains approval gates unless the
 *     caller explicitly sets `auto_approve: true` — there is no operator
 *     present to resume a paused queued run.
 *
 * Trust posture mirrors meta.run-workflow + meta.ptc: `requiresConfirmation:
 * true` so the operator approves enqueuing (which commits to running) the
 * workflow before the queue accepts it.
 *
 * Opt-in: cli.ts initializes the WorkflowQueue AND registers this tool only
 * when SUDO_WORKFLOWS_QUEUE=1. When the flag is OFF, the tool is not in the
 * registry at all.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getWorkflowQueue } from '../../../workflows/queue.js';
import type { TaskPriority } from '../../../orchestration/task-queue.js';

const logger = createLogger('meta.enqueue-workflow');

const VALID_PRIORITIES = new Set<TaskPriority>([
  'critical',
  'high',
  'normal',
  'low',
  'background',
]);

function isPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && VALID_PRIORITIES.has(v as TaskPriority);
}

export const enqueueWorkflowTool: ToolDefinition = {
  name: 'meta.enqueue-workflow',
  description:
    'Schedule a deterministic multi-step workflow to run in the BACKGROUND via ' +
    "the persistent task queue (gap #24 slice 4). The workflow .yaml lives under the " +
    "workspace 'workflows/' directory (same path confinement as meta.run-workflow). " +
    'Queued runs execute concurrently, bounded by SUDO_WORKFLOWS_QUEUE_CONCURRENT ' +
    '(default 2); each run still uses SUDO_WORKFLOWS_MAX_PARALLEL for its OWN ' +
    'intra-workflow fan-out (parallel_group / phase). Pending runs SURVIVE process ' +
    'restarts. Queued runs auto-approve internal `approval: true` gates; this tool ' +
    'REFUSES to enqueue workflows that contain approval gates unless the caller ' +
    'sets auto_approve:true. Returns task_id (use meta.task-manager to monitor) ' +
    'and run_id (matches the resume-journal filename). For interactive workflows ' +
    'with approval gates that should pause for operator input, use meta.run-workflow ' +
    'instead.',
  category: 'meta' as const,
  safety: 'destructive',
  // The workflow's step commands / tool args may not have been authored by the
  // operator — approve enqueuing (which commits to running) the WHOLE workflow
  // before the queue accepts it.
  requiresConfirmation: true,
  timeout: 15_000,
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
        'Required true if the workflow contains any `approval: true` steps. Queued runs ' +
        'have no operator-present resume path, so internal approval gates would deadlock. ' +
        'Setting this to true acknowledges that all internal gates will be auto-approved.',
      default: false,
    },
    priority: {
      type: 'string',
      description:
        'TaskQueue execution priority. Higher-priority queued runs dequeue first.',
      enum: ['critical', 'high', 'normal', 'low', 'background'],
      default: 'normal',
    },
    depends_on: {
      type: 'array',
      description:
        'Array of TaskQueue task IDs that must complete before this workflow runs. ' +
        'Useful for chaining workflows (run B only after A completes).',
      items: { type: 'string', description: 'Task ID from a prior enqueue call' },
    },
    max_retries: {
      type: 'number',
      description:
        'Maximum retry attempts on failure. Default 0 because most workflows are NOT ' +
        'idempotent (file writes, tool calls with side effects). Set explicitly only ' +
        'for workflows authored to be replay-safe.',
      default: 0,
    },
    timeout_ms: {
      type: 'number',
      description:
        'Per-run timeout in ms. Default 30 minutes. The TaskExecutor aborts and marks ' +
        'the task failed after this; the workflow engine itself does not yet plumb a ' +
        'mid-run cancel signal (best-effort).',
      default: 30 * 60 * 1_000,
    },
    journal_dir: {
      type: 'string',
      description:
        'Directory the engine rewrites a per-run resume journal into after every settled ' +
        'step. A relative path is rejected; an absolute path is used as-is. Defaults to ' +
        '<DATA_DIR>/workflow-runs/. Must be inside DATA_DIR or WORKSPACE_DIR.',
    },
    run_id: {
      type: 'string',
      description:
        'Optional pre-minted run id. Used as the journal filename and the resume id. ' +
        'Most callers omit this and let the queue mint one.',
    },
    description: {
      type: 'string',
      description:
        'Operator-friendly description that shows up in meta.task-manager list output.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const queue = getWorkflowQueue();
    if (!queue) {
      return {
        success: false,
        output:
          'meta.enqueue-workflow: WorkflowQueue is not initialized. ' +
          'cli.ts wires this when SUDO_WORKFLOWS_QUEUE=1.',
      };
    }

    const file = typeof params['file'] === 'string' ? (params['file'] as string).trim() : '';
    if (file === '') {
      return { success: false, output: 'meta.enqueue-workflow: "file" must be a non-empty string' };
    }

    const autoApprove = params['auto_approve'] === true;

    const rawPriority = params['priority'];
    let priority: TaskPriority = 'normal';
    if (rawPriority !== undefined) {
      if (!isPriority(rawPriority)) {
        return {
          success: false,
          output: `meta.enqueue-workflow: priority must be one of ${[...VALID_PRIORITIES].join(', ')}`,
        };
      }
      priority = rawPriority;
    }

    const dependsOn = Array.isArray(params['depends_on'])
      ? ((params['depends_on'] as unknown[]).filter((v) => typeof v === 'string') as string[])
      : [];

    const maxRetriesRaw = params['max_retries'];
    let maxRetries = 0;
    if (maxRetriesRaw !== undefined) {
      if (typeof maxRetriesRaw !== 'number' || !Number.isFinite(maxRetriesRaw) || maxRetriesRaw < 0) {
        return { success: false, output: 'meta.enqueue-workflow: max_retries must be a non-negative number' };
      }
      maxRetries = Math.min(10, Math.floor(maxRetriesRaw));
    }

    const timeoutMsRaw = params['timeout_ms'];
    let timeoutMs = 30 * 60 * 1_000;
    if (timeoutMsRaw !== undefined) {
      if (typeof timeoutMsRaw !== 'number' || !Number.isFinite(timeoutMsRaw) || timeoutMsRaw < 1_000) {
        return {
          success: false,
          output: 'meta.enqueue-workflow: timeout_ms must be a number >= 1000',
        };
      }
      timeoutMs = Math.min(6 * 60 * 60 * 1_000, Math.floor(timeoutMsRaw));
    }

    const journalDir = typeof params['journal_dir'] === 'string'
      ? (params['journal_dir'] as string).trim() || undefined
      : undefined;

    const runId = typeof params['run_id'] === 'string'
      ? (params['run_id'] as string).trim() || undefined
      : undefined;
    if (runId !== undefined && !/^[A-Za-z0-9_-]+$/.test(runId)) {
      return { success: false, output: 'meta.enqueue-workflow: run_id is malformed' };
    }

    const description = typeof params['description'] === 'string'
      ? (params['description'] as string).trim() || undefined
      : undefined;

    logger.info(
      {
        sessionId: ctx.sessionId,
        file,
        autoApprove,
        priority,
        dependsCount: dependsOn.length,
        maxRetries,
        timeoutMs,
      },
      'Enqueuing workflow',
    );

    try {
      const result = await queue.enqueueWorkflow({
        file,
        autoApprove,
        priority,
        dependsOn,
        maxRetries,
        timeoutMs,
        ...(journalDir !== undefined ? { journalDir } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(description !== undefined ? { description } : {}),
        createdBy: ctx.sessionId ? `session:${ctx.sessionId}` : 'system',
      });

      const lines = [
        `workflow "${result.workflowName}" enqueued`,
        `  task_id: ${result.taskId}`,
        `  run_id:  ${result.runId}`,
        `  status:  ${result.status}`,
        `  priority: ${priority}${dependsOn.length > 0 ? ` (blocked on ${dependsOn.length} dep(s))` : ''}`,
        '',
        'Monitor with meta.task-manager (action: get|list|cancel).',
      ];

      return {
        success: true,
        output: lines.join('\n'),
        data: {
          taskId: result.taskId,
          runId: result.runId,
          workflowName: result.workflowName,
          status: result.status,
          priority,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `meta.enqueue-workflow: ${msg}`,
      };
    }
  },
};
