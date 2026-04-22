/**
 * Upgrade 59: Background Research Agent
 *
 * Lightweight task queue for asynchronous research operations.  The agent loop
 * starts a research task, continues working on other things, and is notified
 * via an optional callback when findings arrive.
 *
 * Findings and sources are stored in memory; callers are responsible for
 * persisting results if they need to survive process restarts.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:research');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResearchStatus = 'queued' | 'researching' | 'completed' | 'failed';

export interface ResearchTask {
  id: string;
  query: string;
  status: ResearchStatus;
  findings: string[];
  sources: string[];
  startedAt: string;
  completedAt?: string;
  failedReason?: string;
  onComplete?: (task: ResearchTask) => void;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const tasks: Map<string, ResearchTask> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new research task and return its handle.
 *
 * The task begins in 'queued' status.  The actual research work must be driven
 * by the caller (e.g. through web search tool calls) by invoking addFinding
 * and then completeResearch.
 *
 * @param query       The research question or topic.
 * @param onComplete  Optional callback invoked when completeResearch is called.
 */
export function startResearch(
  query: string,
  onComplete?: (task: ResearchTask) => void,
): ResearchTask {
  if (!query?.trim()) throw new Error('Research query must not be empty');

  const task: ResearchTask = {
    id: `research-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    query: query.trim(),
    status: 'queued',
    findings: [],
    sources: [],
    startedAt: new Date().toISOString(),
    onComplete,
  };

  tasks.set(task.id, task);
  log.info({ id: task.id, query: task.query.substring(0, 60) }, 'Research task started');

  return task;
}

/**
 * Append a finding (and optional source URL) to an existing research task.
 * Automatically transitions status from 'queued' to 'researching'.
 *
 * @param id      Task ID returned by startResearch.
 * @param finding Fact or insight to record.
 * @param source  Optional URL or citation for the finding.
 */
export function addFinding(id: string, finding: string, source?: string): void {
  const task = tasks.get(id);
  if (!task) {
    log.warn({ id }, 'addFinding: task not found');
    return;
  }
  if (!finding?.trim()) {
    log.warn({ id }, 'addFinding: empty finding ignored');
    return;
  }

  task.findings.push(finding.trim());
  if (source?.trim()) task.sources.push(source.trim());

  if (task.status === 'queued') task.status = 'researching';

  log.debug({ id, totalFindings: task.findings.length }, 'Finding added');
}

/**
 * Mark a research task as completed and invoke the onComplete callback if set.
 */
export function completeResearch(id: string): void {
  const task = tasks.get(id);
  if (!task) {
    log.warn({ id }, 'completeResearch: task not found');
    return;
  }
  if (task.status === 'completed' || task.status === 'failed') {
    log.warn({ id, status: task.status }, 'completeResearch called on already-terminal task');
    return;
  }

  task.status = 'completed';
  task.completedAt = new Date().toISOString();

  log.info({ id, findings: task.findings.length }, 'Research completed');

  if (task.onComplete) {
    try {
      task.onComplete(task);
    } catch (err) {
      log.error({ id, error: (err as Error).message }, 'onComplete callback threw');
    }
  }
}

/**
 * Mark a research task as failed with an explanatory reason.
 */
export function failResearch(id: string, reason: string): void {
  const task = tasks.get(id);
  if (!task) {
    log.warn({ id }, 'failResearch: task not found');
    return;
  }

  task.status = 'failed';
  task.failedReason = reason;
  task.completedAt = new Date().toISOString();

  log.warn({ id, reason }, 'Research failed');
}

/**
 * Retrieve a task by ID.  Returns undefined if not found.
 */
export function getResearch(id: string): ResearchTask | undefined {
  return tasks.get(id);
}

/**
 * Return all research tasks (active and completed).
 */
export function listResearch(): ResearchTask[] {
  return Array.from(tasks.values());
}

/**
 * Format a research task as a readable markdown summary.
 */
export function formatResearch(task: ResearchTask): string {
  if (!task) return 'No research task provided.';

  const lines: string[] = [
    `**Research: ${task.query}** (${task.status})`,
  ];

  if (task.findings.length === 0) {
    lines.push('_No findings recorded yet._');
  } else {
    for (const [i, f] of task.findings.entries()) {
      lines.push(`${i + 1}. ${f}`);
      if (task.sources[i]) lines.push(`   Source: ${task.sources[i]}`);
    }
  }

  if (task.failedReason) lines.push(`\n_Failure reason: ${task.failedReason}_`);
  if (task.completedAt) lines.push(`\n_Completed: ${task.completedAt}_`);

  return lines.join('\n');
}
