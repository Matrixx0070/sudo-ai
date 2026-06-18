/**
 * @file agent-tasks/index.ts
 * @description Barrel export for the canonical agent benchmark task suite.
 */

import type { AgentBenchTask } from '../agent-bench-types.js';
import { divideBugTask } from './divide-bug.js';
import { implementFromSpecTask } from './implement-from-spec.js';
import { jsBugFixTask } from './js-bug-fix.js';
import { multiFileRenameTask } from './multi-file-rename.js';

export { divideBugTask, implementFromSpecTask, jsBugFixTask, multiFileRenameTask };

/** All built-in agent benchmark tasks, in stable order. */
export const ALL_AGENT_TASKS: AgentBenchTask[] = [
  divideBugTask,
  jsBugFixTask,
  implementFromSpecTask,
  multiFileRenameTask,
];

/** Lookup table by task id. */
export const AGENT_TASKS_BY_ID: Record<string, AgentBenchTask> = Object.fromEntries(
  ALL_AGENT_TASKS.map(t => [t.id, t]),
);
