/**
 * Internal helpers for AgentLoop — F103 barrel.
 *
 * The former 2,161-line monolith was mechanically decomposed (zero behavior
 * change, pure move) into src/core/agent/loop-helpers/:
 *   - types.ts            shared duck-typed interfaces (Brain*, ToolContext, *Like, Emitter)
 *   - context-fold.ts     compaction: verbatim tail, pinned goal, pairing repair, escalation
 *   - tool-parallel.ts    parallel-safety classification + partition + concurrency cap
 *   - tool-exec.ts        single tool-call execution, verify-gate/critic slices, fallback chain
 *   - tool-batch.ts       executeToolCalls batch orchestration (approval, trust-tier, commit)
 *   - prepare-messages.ts pre-call preparation LAYER 0-5 + turn digests
 *   - loop-controls.ts    session trim + GoalPlanner semantic cap
 *
 * Every name previously exported from this file is re-exported below, so
 * importers of './loop-helpers.js' compile unchanged. Not part of the public
 * barrel export — only imported by loop.ts (and tests).
 */

export type {
  BrainMessage,
  BrainRequest,
  BrainResponse,
  ToolContext,
  BrainLike,
  ToolDescriptor,
  ToolRegistryLike,
  SessionLike,
  Emitter,
  HookEmitterLike,
  VerifyGateLike,
  GroundingCheckerLike,
  CriticPassLike,
  SecurityGuardLike,
  SandboxManagerLike,
  FeedbackMemoryLike,
} from './loop-helpers/types.js';

export {
  selectVerbatimTail,
  PINNED_GOAL_PREFIX,
  selectPinnedGoal,
  TRUNCATED_TOOL_RESULT_PLACEHOLDER,
  sanitizeToolPairing,
  runCompaction,
  escalateCompaction,
} from './loop-helpers/context-fold.js';
export type { PreCompactionFlush } from './loop-helpers/context-fold.js';

export { _isParallelSafe, _partitionToolCalls } from './loop-helpers/tool-parallel.js';

export { _toolNotFoundFallback } from './loop-helpers/tool-exec.js';
export type { PreventionLookupLike } from './loop-helpers/tool-exec.js';

export { executeToolCalls } from './loop-helpers/tool-batch.js';

export {
  collapseContent,
  extractTurnMutations,
  classifyShipEditSignals,
  dropPriorAlignmentAdvisories,
  prepareMessages,
} from './loop-helpers/prepare-messages.js';

export {
  SESSION_MESSAGE_TRIM_THRESHOLD,
  SESSION_MESSAGE_KEEP_COUNT,
  trimSessionMessages,
  resolveSemanticPlanCap,
  semanticPlanAllowed,
} from './loop-helpers/loop-controls.js';
