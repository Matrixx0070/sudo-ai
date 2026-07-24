/**
 * @file agent-tasks/index.ts
 * @description Barrel export for the canonical agent benchmark task suite.
 */

import type { AgentBenchTask } from '../agent-bench-types.js';
import { deadCodeCleanupTask } from './dead-code-cleanup.js';
import { divideBugTask } from './divide-bug.js';
import { implementFromSpecTask } from './implement-from-spec.js';
import { jsBugFixTask } from './js-bug-fix.js';
import { multiFileRenameTask } from './multi-file-rename.js';
import { multipartCompletenessTask } from './multipart-completeness.js';
import { slugifyEdgesTask } from './slugify-edges.js';
import { stackTraceDebugTask } from './stack-trace-debug.js';

export {
  deadCodeCleanupTask,
  divideBugTask,
  implementFromSpecTask,
  jsBugFixTask,
  multiFileRenameTask,
  multipartCompletenessTask,
  slugifyEdgesTask,
  stackTraceDebugTask,
};

/** All built-in agent benchmark tasks, in stable order (easier → harder). */
export const ALL_AGENT_TASKS: AgentBenchTask[] = [
  divideBugTask,
  jsBugFixTask,
  implementFromSpecTask,
  multiFileRenameTask,
  stackTraceDebugTask,
  deadCodeCleanupTask,
  slugifyEdgesTask,
  multipartCompletenessTask,
];

/** Lookup table by task id. */
export const AGENT_TASKS_BY_ID: Record<string, AgentBenchTask> = Object.fromEntries(
  ALL_AGENT_TASKS.map(t => [t.id, t]),
);
