/**
 * @file hooks/typed-hooks.ts
 * @description Typed hook definitions with block/approval/transform semantics
 *              for SUDO-AI v4.
 *
 * Each HookEvent is mapped to a structured result type so that hook consumers
 * and authors know exactly what a hook can do: block an action, request
 * approval, rewrite arguments, inject context, transform output, etc.
 *
 * The `TYPED_HOOK_MAP` constant ties every HookEvent to its runner type
 * (void / modifying / claiming) and the name of the result interface it
 * produces.  The `getHookRunnerType()` convenience function lets callers
 * look up the runner type without importing the full map.
 */

import type { HookEvent } from './index.js';
import type { HookRunnerType } from './hook-runner.js';

// --- 1. PreToolCallResult (before:tool-call) ---------------------------------
// Block execution, gate on approval, or rewrite tool arguments.

/** Result of a pre-tool-call hook. */
export interface PreToolCallResult {
  /** True to prevent the tool from executing. */
  blocked?: boolean;
  /** Approval gate decision. 'pending' pauses for user confirmation. */
  approval?: 'approved' | 'denied' | 'pending';
  /** Replacement arguments — merged into the tool call when provided. */
  rewrite?: Record<string, unknown>;
}

// --- 2. PostToolCallResult (after:tool-call) ----------------------------------
// Optionally modify the tool result or record execution duration.

/** Result of a post-tool-call hook. */
export interface PostToolCallResult {
  /** Replacement result — replaces the original tool output when provided. */
  result?: unknown;
  /** Wall-clock execution time in milliseconds. */
  duration?: number;
}

// --- 3. PreLLMCallResult (before:brain-call, before_prompt_build) -------------
// Inject context or append to the system prompt before the LLM sees it.

/** Result of a pre-LLM-call hook. */
export interface PreLLMCallResult {
  /** Additional context string injected into the user/assistant turn. */
  contextInject?: string;
  /** Text appended to the system prompt (visible to model only). */
  systemPromptAppend?: string;
}

// --- 4. TransformToolResultResult (after:tool-call transform variant) ----------
// Rewrite or redact tool output before it reaches the model.

/** Result of a tool-result transformation hook. */
export interface TransformToolResultResult {
  /** Transformed tool output. */
  result?: unknown;
  /** True when sensitive data was removed or masked. */
  redacted?: boolean;
}

// --- 5. TransformLLMOutputResult (after:brain-call transform variant) ----------
// Rewrite or redact LLM output before downstream consumers see it.

/** Result of an LLM-output transformation hook. */
export interface TransformLLMOutputResult {
  /** Transformed LLM output string. */
  content?: string;
  /** True when sensitive data was removed or masked. */
  redacted?: boolean;
}

// --- 6. OnErrorResult (on:error) ----------------------------------------------
// Mark an error as handled, request retry, or supply a replacement value.

/** Result of an error-handling hook. */
export interface OnErrorResult {
  /** True when the hook has handled the error (suppress default handling). */
  handled?: boolean;
  /** True to retry the failed operation. */
  retry?: boolean;
  /** Delay in ms before retrying (only meaningful when retry is true). */
  retryDelay?: number;
  /** Fallback value to use instead of propagating the error. */
  replacement?: string;
}

// --- 7. SteeringResult (steering:received) ------------------------------------
// Inject steering text or select a steering mode.

/** Result of a steering hook. */
export interface SteeringResult {
  /** Additional steering text to inject into the agent's context. */
  inject?: string;
  /** Steering mode — controls how the agent interprets the signal. */
  mode?: 'steer' | 'followup' | 'collect' | 'interrupt';
}

// --- 8. CompactionResult (before_compaction, pre:compact) ---------------------
// Advise the compaction strategy and token budget.

/** Result of a compaction advisory hook. */
export interface CompactionResult {
  /** Suggested compaction aggressiveness. */
  stage?: 'mild' | 'moderate' | 'aggressive' | 'emergency';
  /** Upper token limit for the compacted output. */
  maxTokens?: number;
}

// --- 9. SecurityResult (tool:approved, tool:denied, memory:scan:triggered) ----
// Block, explain, or escalate security decisions.

/** Result of a security hook. */
export interface SecurityResult {
  /** True to block the action. */
  blocked?: boolean;
  /** Human-readable reason for the block (shown in logs / UI). */
  reason?: string;
  /** True to escalate to a human reviewer. */
  escalate?: boolean;
}

// --- 10. MemoryResult (dream:start, dream:end) --------------------------------
// Block memory operations or request sanitisation.

/** Result of a memory hook. */
export interface MemoryResult {
  /** True to block the memory operation. */
  blocked?: boolean;
  /** Sanitised version of the memory content (replaces original). */
  sanitize?: string;
}

// --- 11. VaultResult (vault:set, vault:get, vault:rotate, vault:delete) ------
// Block or audit vault access.

/** Result of a vault hook. */
export interface VaultResult {
  /** True to block the vault operation. */
  blocked?: boolean;
  /** Audit message recorded alongside the vault access. */
  audit?: string;
}

// --- 12. GoalResult (goal:created, goal:completed) ----------------------------
// Block goal changes or adjust priority.

/** Result of a goal hook. */
export interface GoalResult {
  /** True to block the goal transition. */
  blocked?: boolean;
  /** Override priority for the goal (higher = more important). */
  priority?: number;
}

// --- 13. AgentResult (agent:bootstrap, swarm:spawn, teammate:idle) -----------
// Block or redirect agent actions.

/** Result of an agent hook. */
export interface AgentResult {
  /** True to block the agent action. */
  blocked?: boolean;
  /** Redirect the agent to a different target or behaviour. */
  redirect?: string;
}

// --- 14. MessageResult (message:received, message:sent, on:message) ----------
// Block, transform, or reroute messages.

/** Result of a message hook. */
export interface MessageResult {
  /** True to suppress the message. */
  blocked?: boolean;
  /** Transformed message body (replaces original). */
  transform?: string;
  /** Alternate routing destination (e.g. channel name). */
  route?: string;
}

// --- 15. GenericResult (fallback for untyped events) --------------------------

/** Result of a generic (untyped) hook. */
export interface GenericResult {
  /** True to block the associated action. */
  blocked?: boolean;
  /** Opaque transformed payload. */
  transform?: unknown;
}

// ---------------------------------------------------------------------------
// TYPED_HOOK_MAP
// ---------------------------------------------------------------------------

/**
 * Maps every HookEvent to its runner type and result interface name.
 *
 * `resultType` stores the interface name as a string for introspection and
 * documentation; runtime code should narrow via type predicates.
 */
export const TYPED_HOOK_MAP: Record<HookEvent, { runnerType: HookRunnerType; resultType: string }> = {
  // -- Core tool / brain events --
  'before:tool-call':    { runnerType: 'claiming',  resultType: 'PreToolCallResult' },
  'after:tool-call':     { runnerType: 'modifying', resultType: 'PostToolCallResult' },
  'before:brain-call':   { runnerType: 'modifying', resultType: 'PreLLMCallResult' },
  'after:brain-call':    { runnerType: 'modifying', resultType: 'TransformLLMOutputResult' },
  'on:error':            { runnerType: 'claiming',  resultType: 'OnErrorResult' },
  'on:file-write':       { runnerType: 'void',      resultType: 'GenericResult' },
  'on:message':          { runnerType: 'modifying', resultType: 'MessageResult' },

  // -- Lifecycle events --
  'session:start':       { runnerType: 'void',      resultType: 'GenericResult' },
  'session:end':         { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Memory events --
  'pre:compact':         { runnerType: 'modifying', resultType: 'CompactionResult' },
  'post:compact':        { runnerType: 'void',      resultType: 'GenericResult' },
  'dream:start':         { runnerType: 'claiming',  resultType: 'MemoryResult' },
  'dream:end':           { runnerType: 'void',      resultType: 'MemoryResult' },

  // -- Agent events --
  'instructions:loaded':  { runnerType: 'void',      resultType: 'GenericResult' },
  'teammate:idle':        { runnerType: 'claiming',  resultType: 'AgentResult' },
  'swarm:spawn':          { runnerType: 'claiming',  resultType: 'AgentResult' },
  'swarm:complete':       { runnerType: 'void',      resultType: 'GenericResult' },
  'background:start':     { runnerType: 'void',      resultType: 'GenericResult' },
  'background:complete':  { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Goal events --
  'goal:created':         { runnerType: 'claiming',  resultType: 'GoalResult' },
  'goal:completed':       { runnerType: 'void',      resultType: 'GoalResult' },

  // -- Security events --
  'tool:approved':        { runnerType: 'void',      resultType: 'SecurityResult' },
  'tool:denied':          { runnerType: 'void',      resultType: 'SecurityResult' },

  // -- Steering events --
  'steering:received':    { runnerType: 'modifying', resultType: 'SteeringResult' },

  // -- Integration events --
  'mcp:connected':        { runnerType: 'void',      resultType: 'GenericResult' },
  'a2a:message':          { runnerType: 'modifying', resultType: 'MessageResult' },
  'file:changed':         { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Command lifecycle (OpenClaw parity) --
  'command:new':          { runnerType: 'void',      resultType: 'GenericResult' },
  'command:reset':        { runnerType: 'void',      resultType: 'GenericResult' },
  'command:stop':         { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Session compaction (OpenClaw parity) --
  'session:compact:before':  { runnerType: 'modifying', resultType: 'CompactionResult' },
  'session:compact:after':   { runnerType: 'void',      resultType: 'GenericResult' },
  'session:compact:patch':   { runnerType: 'modifying', resultType: 'GenericResult' },

  // -- Agent bootstrap --
  'agent:bootstrap':      { runnerType: 'modifying', resultType: 'AgentResult' },

  // -- Gateway lifecycle --
  'gateway:startup':      { runnerType: 'void',      resultType: 'GenericResult' },
  'gateway:shutdown':     { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Message lifecycle --
  'message:received':     { runnerType: 'claiming',  resultType: 'MessageResult' },
  'message:transcribed':  { runnerType: 'modifying', resultType: 'MessageResult' },
  'message:preprocessed': { runnerType: 'modifying', resultType: 'MessageResult' },
  'message:sent':         { runnerType: 'void',      resultType: 'MessageResult' },

  // -- Model / prompt pipeline --
  'before_model_resolve': { runnerType: 'modifying', resultType: 'PreLLMCallResult' },
  'before_prompt_build':  { runnerType: 'modifying', resultType: 'PreLLMCallResult' },

  // -- Persistence --
  'tool_result_persist':  { runnerType: 'void',      resultType: 'GenericResult' },
  'tool_batch_complete':  { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Compaction aliases --
  'before_compaction':    { runnerType: 'modifying', resultType: 'CompactionResult' },
  'after_compaction':     { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Install lifecycle --
  'before_install':       { runnerType: 'claiming',  resultType: 'GenericResult' },
  'after_install':        { runnerType: 'void',      resultType: 'GenericResult' },

  // -- Vault events --
  'vault:set':            { runnerType: 'claiming',  resultType: 'VaultResult' },
  'vault:get':            { runnerType: 'claiming',  resultType: 'VaultResult' },
  'vault:rotate':         { runnerType: 'claiming',  resultType: 'VaultResult' },
  'vault:delete':         { runnerType: 'claiming',  resultType: 'VaultResult' },

  // -- Rate limit / MCP loopback --
  'rate-limit:triggered': { runnerType: 'claiming',  resultType: 'SecurityResult' },
  'mcp:tool-call':        { runnerType: 'claiming',  resultType: 'PreToolCallResult' },

  // -- Cost optimisation / Memory security --
  'model:route:cheap':    { runnerType: 'claiming',  resultType: 'SteeringResult' },
  'memory:scan:triggered': { runnerType: 'claiming', resultType: 'SecurityResult' },

  // -- Task management events --
  'task:created':         { runnerType: 'void',      resultType: 'GenericResult' },
  'task:completed':       { runnerType: 'void',      resultType: 'GenericResult' },
};

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Look up the runner type for a given HookEvent without importing the
 * full TYPED_HOOK_MAP.
 *
 * @example
 * ```ts
 * const runner = getHookRunnerType('before:tool-call'); // 'claiming'
 * ```
 */
export function getHookRunnerType(event: HookEvent): HookRunnerType {
  return TYPED_HOOK_MAP[event].runnerType;
}