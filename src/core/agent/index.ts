/**
 * Public barrel export for src/core/agent.
 * Import from this module rather than individual files.
 */

export { AgentLoop } from './loop.js';
export { ToolRouter } from './tool-router.js';
export { StreamingHandler } from './streaming.js';
export { compact } from './compaction.js';
export {
  estimateContextSize,
  trimToolResults,
  shouldCompact,
  MAX_CONTEXT_TOKENS,
} from './context.js';
export type { AgentConfig, AgentState, AgentEvent, AgentEventHandler } from './types.js';
export { generateIntelligenceBrief, type IntelligenceBrief, type WisdomHit } from './intelligence-brief.js';
export { ReACTLoop, type ReACTStep, type ReACTResult, type ReACTConfig, DEFAULT_REACT_CONFIG } from './react-loop.js';
export { buildContentBlocks, toRichResponse, makeBlock } from './content-types.js';
export type { ContentType, ContentBlock, RichResponse } from './content-types.js';
export { PermissionManager } from './permissions.js';
export type { PermissionMode, ToolPermission } from './permissions.js';
export { createIsolatedAgent } from './isolation.js';
export type { IsolationMode, IsolatedAgent } from './isolation.js';
export { CommentaryChannel, commentary } from './commentary.js';
export type { CommentaryType, CommentaryMessage } from './commentary.js';

// Upgrade 18: Truncation Policy
export {
  truncateMessages,
  estimateMessageTokens,
  DEFAULT_POLICY,
} from './truncation.js';
export type { TruncationPolicy, TruncatableMessage } from './truncation.js';

// Upgrade 19: Reasoning Summary
export { buildReasoningSummary, formatReasoningSummary } from './reasoning-summary.js';
export type { ReasoningSummary, AgentAction } from './reasoning-summary.js';

// Upgrade 22: Task Tracker
export { TaskTracker, taskTracker } from './task-tracker.js';
export type { TrackedTask, TaskStatus } from './task-tracker.js';

// Upgrade 24: Response Compressor
export { compressResponse, removeFiller } from './response-compressor.js';

// Upgrade 25: Special User Requests
export { detectSpecialRequest, getSpecialRequestHint } from './special-requests.js';
export type { SpecialRequest } from './special-requests.js';

// Upgrade 26: Clickable File Paths
export { formatFileReferences, fileRef } from './file-references.js';

// Upgrade 32: Agent Messaging
export { mailbox } from './agent-messaging.js';
export type { MailboxMessage } from './agent-messaging.js';

// Upgrade 33: Plan Mode
export {
  enterPlanMode,
  addStep,
  approvePlan,
  exitPlanMode,
  getActivePlan,
  isInPlanMode,
} from './plan-mode.js';
export type { Plan, PlanStep, PlanStatus, PlanStepStatus } from './plan-mode.js';

// Upgrade 34: Remote Triggers (Scheduled Agents)
export {
  createTrigger,
  deleteTrigger,
  listTriggers,
  enableTrigger,
  disableTrigger,
  getActiveTriggers,
  markTriggerFired,
} from './remote-triggers.js';
export type { RemoteTrigger } from './remote-triggers.js';

// Upgrade 38: Cloud Tasks
export {
  createCloudTask,
  updateCloudTask,
  getCloudTask,
  listCloudTasks,
  cancelCloudTask,
} from './cloud-tasks.js';
export type { CloudTask, CloudTaskStatus } from './cloud-tasks.js';

// Upgrade 47: Background Agent Execution
export {
  launchBackground,
  completeBackground,
  failBackground,
  cancelBackground,
  getBackground,
  listBackground,
  getRunning,
} from './background-agent.js';
export type { BackgroundAgent, BackgroundStatus } from './background-agent.js';

// Upgrade 56: ModelEditableContext
export { editableContext } from './editable-context.js';
export type { ContextEntry } from './editable-context.js';

// Upgrade 59: Background Research Agent
export {
  startResearch,
  addFinding,
  completeResearch,
  failResearch,
  getResearch,
  listResearch,
  formatResearch,
} from './research-agent.js';
export type { ResearchTask, ResearchStatus } from './research-agent.js';

// Profile Manager
export { ProfileManager } from './profile.js';
export type { AgentProfile, ProfileConfig } from './profile.js';

// User-facing Task Management (reverse-engineered from Claude Code)
export { TaskManager } from './task-manager.js';
export type {
  ManagedTask,
  CreateTaskOptions,
  TaskListFilter,
  TaskManagerStatus,
  TaskHookEvent,
  TaskPriority as ManagedTaskPriority,
} from './task-manager.js';

// Effort Dial (quality/speed control)
export { EffortDial, setLevel, getLevel, getThinkingTokens, getMaxToolTurns, getVerificationDepth, getSubagentCount, getPricing } from './effort-dial.js';
export type {
  EffortDialLevel,
  EffortDialConfig,
  EffortDialOverrides,
  VerificationDepth,
} from './effort-dial.js';

// Worktree Isolation (parallel agent safety)
export { WorktreeManager } from './worktree-manager.js';
export type {
  WorktreeInfo,
} from './worktree-manager.js';
