/**
 * meta.ultra-plan — Deep planning mode for SUDO-AI.
 *
 * Before executing complex tasks, forces an explicit structured plan to be
 * written out and (optionally) approved before any action is taken.
 * Inspired by Claude Code's extended-thinking planning mode.
 *
 * Actions:
 *   (single action tool — invoked with task + options)
 *
 * Output files:
 *   data/plans/YYYY-MM-DD-HH-MM-<task-slug>.md   — final plan
 *   data/plans/pending/<timestamp>.json           — pending approval record
 *   data/ultraplan.log                            — append-only activity log
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { normalizeBrainText, type ToolBrain } from '../../../brain/brain-text.js';
import { createLogger } from '../../../shared/logger.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../shared/paths.js';

const logger = createLogger('meta.ultra-plan');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PLANS_DIR      = path.join(DATA_DIR, 'plans');
const PENDING_DIR    = path.join(PLANS_DIR, 'pending');
const ULTRAPLAN_LOG  = path.join(DATA_DIR, 'ultraplan.log');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  for (const dir of [DATA_DIR, PLANS_DIR, PENDING_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function ts(): string {
  return new Date().toISOString();
}

function logActivity(message: string): void {
  ensureDirs();
  appendFileSync(ULTRAPLAN_LOG, `[${ts()}] ${message}\n`, 'utf-8');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function planFileName(taskSlug: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `${datePart}-${timePart}-${taskSlug}.md`;
}

// ---------------------------------------------------------------------------
// Plan template builder
// ---------------------------------------------------------------------------

function buildPlanningPrompt(task: string, context?: string): string {
  const contextSection = context
    ? `\n\nAdditional context provided:\n${context}`
    : '';

  return `You are SUDO-AI's deep planning engine. Think carefully and thoroughly about this task.${contextSection}

TASK TO PLAN:
${task}

Produce a structured execution plan with ALL of the following sections:

# ULTRAPLAN: ${task}

## 1. Goals
Clear statement of what success looks like. Primary goal and secondary goals.

## 2. Dependencies
What must exist, be true, or be completed BEFORE execution starts.
List: tools, data, permissions, prior steps.

## 3. Risk Assessment
What could go wrong? Rate each risk: LOW / MEDIUM / HIGH.
For each HIGH risk, provide a mitigation strategy.

## 4. Step-by-Step Execution Plan
Number each step. For each step:
- Action: what to do
- Tool(s): which SUDO-AI tool(s) to use (if any)
- Estimated Complexity: TRIVIAL / LOW / MEDIUM / HIGH
- Expected Output: what this step produces
- Dependency: which prior step(s) this relies on

## 5. Rollback Strategy
If execution fails partway through, how to safely undo changes and return to a known-good state.

## 6. Success Criteria
Concrete, measurable conditions that confirm the task is complete.
How will you VERIFY success after execution?

## 7. Estimated Total Effort
Time estimate and resource usage (API calls, disk, compute).

---
Think deeply. Be exhaustive. A thorough plan prevents mistakes.`;
}

// ---------------------------------------------------------------------------
// Approval polling
// ---------------------------------------------------------------------------

interface PendingRecord {
  timestamp: string;
  task: string;
  planFile: string;
  status: 'pending' | 'approved' | 'rejected';
  thinkingTimeMs: number;
}

function pollForApproval(pendingFile: string, timeoutMs = 60_000): 'approved' | 'rejected' | 'timeout' {
  const interval = 3_000;
  const maxChecks = Math.floor(timeoutMs / interval);

  for (let i = 0; i < maxChecks; i++) {
    // Synchronous sleep via busy-wait alternative: use Atomics.wait on a SharedArrayBuffer
    // Simple approach: check file, then sleep using a synchronous spin-wait
    const waitUntil = Date.now() + interval;
    while (Date.now() < waitUntil) {
      // spin — avoids async in a sync polling context
    }

    try {
      if (!existsSync(pendingFile)) continue;
      const record = JSON.parse(readFileSync(pendingFile, 'utf-8')) as PendingRecord;
      if (record.status === 'approved') return 'approved';
      if (record.status === 'rejected') return 'rejected';
    } catch {
      // file may be partially written — retry
    }
  }

  return 'timeout';
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function executePlan(
  task: string,
  context: string | undefined,
  thinkingBudgetMinutes: number,
  autoApprove: boolean,
  ctx: ToolContext,
): Promise<ToolResult> {
  ensureDirs();

  const startMs = Date.now();
  const taskSlug = slugify(task);
  const timestamp = Date.now();

  logActivity(`ULTRAPLAN START task="${task}" budget=${thinkingBudgetMinutes}min autoApprove=${autoApprove} session=${ctx.sessionId}`);
  logger.info({ task, thinkingBudgetMinutes, autoApprove, session: ctx.sessionId }, 'ultra-plan: starting deep planning');

  // ---------------------------------------------------------------------------
  // Build plan via brain (if available) or produce template
  // ---------------------------------------------------------------------------

  const planningPrompt = buildPlanningPrompt(task, context);
  let planContent: string;

  interface ConfigLike { brain?: ToolBrain }

  const config = ctx.config as ConfigLike | undefined;
  if (config?.brain) {
    try {
      logger.info({ task }, 'ultra-plan: calling brain for deep plan');
      const response = await config.brain.chat([
        { role: 'system', content: 'You are a meticulous AI planning engine. Produce structured, thorough execution plans. Think step by step. Be exhaustive.' },
        { role: 'user', content: planningPrompt },
      ]);
      planContent = normalizeBrainText(response).trim();
    } catch (err) {
      logger.warn({ err: String(err) }, 'ultra-plan: brain call failed, using template');
      planContent = `${planningPrompt}\n\n---\n*Note: Brain unavailable — this is the planning template. Fill in each section before executing.*`;
    }
  } else {
    // Brain not injected — return the planning template so the agent fills it in
    planContent = `${planningPrompt}\n\n---\n*Brain not available via tool context. Use this template to plan before acting.*`;
  }

  const thinkingTimeMs = Date.now() - startMs;

  // ---------------------------------------------------------------------------
  // Write plan file
  // ---------------------------------------------------------------------------

  const planFile = path.join(PLANS_DIR, planFileName(taskSlug));
  writeFileSync(planFile, planContent, 'utf-8');
  logActivity(`ULTRAPLAN WROTE planFile="${planFile}" thinkingMs=${thinkingTimeMs}`);
  logger.info({ planFile, thinkingTimeMs }, 'ultra-plan: plan written');

  // ---------------------------------------------------------------------------
  // Approval gate
  // ---------------------------------------------------------------------------

  if (autoApprove) {
    logActivity(`ULTRAPLAN AUTO-APPROVED task="${task}"`);
    return {
      success: true,
      output: [
        `ULTRAPLAN COMPLETE (auto-approved)`,
        `Task: ${task}`,
        `Thinking time: ${(thinkingTimeMs / 1000).toFixed(1)}s`,
        `Plan saved to: ${planFile}`,
        ``,
        `--- PLAN ---`,
        planContent,
      ].join('\n'),
      data: {
        plan: planContent,
        planFile,
        status: 'auto-approved',
        thinkingTimeMs,
      },
      artifacts: [{ path: planFile, action: 'created' }],
    };
  }

  // Write pending approval record
  const pendingFile = path.join(PENDING_DIR, `${timestamp}.json`);
  const pendingRecord: PendingRecord = {
    timestamp: ts(),
    task,
    planFile,
    status: 'pending',
    thinkingTimeMs,
  };
  writeFileSync(pendingFile, JSON.stringify(pendingRecord, null, 2), 'utf-8');
  logActivity(`ULTRAPLAN PENDING approval pendingFile="${pendingFile}"`);

  // Present plan and await approval
  logger.info({ pendingFile }, 'ultra-plan: waiting for approval (60s timeout)');

  const approvalResult = pollForApproval(pendingFile, 60_000);

  const finalStatus: 'approved' | 'rejected' | 'pending' =
    approvalResult === 'timeout' ? 'pending' : approvalResult;

  logActivity(`ULTRAPLAN APPROVAL_RESULT status="${finalStatus}" task="${task}"`);

  const statusLine =
    finalStatus === 'approved'
      ? 'APPROVED — proceed with execution.'
      : finalStatus === 'rejected'
        ? 'REJECTED — do NOT execute this plan. Revise and re-plan.'
        : 'PENDING — approval not received within 60s. Treat as pending; do not auto-execute.';

  return {
    success: finalStatus !== 'rejected',
    output: [
      `ULTRAPLAN ${finalStatus.toUpperCase()}`,
      `Task: ${task}`,
      `Status: ${statusLine}`,
      `Thinking time: ${(thinkingTimeMs / 1000).toFixed(1)}s`,
      `Plan file: ${planFile}`,
      `Approval record: ${pendingFile}`,
      ``,
      `--- PLAN ---`,
      planContent,
    ].join('\n'),
    data: {
      plan: planContent,
      planFile,
      pendingFile,
      status: finalStatus,
      thinkingTimeMs,
    },
    artifacts: [
      { path: planFile, action: 'created' },
      { path: pendingFile, action: 'created' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ultraPlanTool: ToolDefinition = {
  name: 'meta.ultra-plan',
  description:
    'Deep planning mode — spend up to 30 minutes thinking through complex tasks before execution. ' +
    'Produces a structured execution plan (goals, dependencies, risks, step-by-step actions with complexity estimates, ' +
    'rollback strategy, success criteria) and saves it to data/plans/. Shows plan in UI for approval before any action ' +
    'is taken. Use this BEFORE starting any multi-step, irreversible, or risky task.',
  category: 'meta',
  timeout: 30 * 60 * 1000, // 30 minutes max
  parameters: {
    task: {
      type: 'string',
      required: true,
      description: 'The complex task to plan. Be specific — this drives the entire planning process.',
    },
    context: {
      type: 'string',
      required: false,
      description: 'Additional context to inform the plan (current state, constraints, prior attempts, etc.).',
    },
    thinkingBudget: {
      type: 'number',
      required: false,
      default: 10,
      description: 'Minutes of thinking time to allocate (default: 10, max: 30). Longer = more thorough plan.',
    },
    autoApprove: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true, skip the approval gate and proceed immediately after planning. Use only for safe, reversible tasks.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = params['task'] as string | undefined;
    if (!task?.trim()) {
      return { success: false, output: 'task is required and must be a non-empty string.' };
    }

    const context        = params['context'] as string | undefined;
    const rawBudget      = (params['thinkingBudget'] as number | undefined) ?? 10;
    const thinkingBudget = Math.min(30, Math.max(1, rawBudget));
    const autoApprove    = (params['autoApprove'] as boolean | undefined) ?? false;

    logger.info({ task, thinkingBudget, autoApprove, session: ctx.sessionId }, 'meta.ultra-plan invoked');

    try {
      return await executePlan(task, context, thinkingBudget, autoApprove, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ task, err: msg }, 'meta.ultra-plan error');
      return { success: false, output: `ULTRAPLAN error: ${msg}` };
    }
  },
};
