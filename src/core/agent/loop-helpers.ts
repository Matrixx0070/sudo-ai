/**
 * Internal helpers for AgentLoop.
 *
 * Extracted to keep loop.ts under 300 lines.
 * Not part of the public barrel export — only imported by loop.ts.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError, ToolError } from '../shared/errors.js';
import { compact, microCompact, autoCompact, fullCompact, type AutoCompactFailureCounter } from './compaction.js';
import { microCompactMessages, type MicroCompactMessage } from './microcompact.js';
import { shouldCompact, estimateContextSize, MAX_CONTEXT_TOKENS } from './context.js';
import { PRE_COMPACTION_FLUSH, PRE_COMPACTION_FLUSH_THRESHOLD } from '../shared/constants.js';
import { approvalManager } from './approval.js';
import { PermissionManager } from './permissions.js';
import type { AgentState, AgentEvent } from './types.js';
import type { ToolSchema } from '../tools/types.js';
import { resolveEffort, type EffortLevel } from './effort.js';
import { clampToolOutput } from './tool-output-clamp.js';
import { shouldUseInterleavedThinking, buildThinkingBlock } from './interleaved-thinking.js';
import {
  readCriticFeedbackEnabled,
  renderCriticFeedback,
  readCriticBlockEnabled,
  renderCriticBlockMessage,
} from './verify-gate-critic.js';
import { isGroundingBlockEnabled } from './verify-gate-grounding.js';

const log = createLogger('agent:loop');

// ---------------------------------------------------------------------------
// Shared duck-typed interfaces (mirrors loop.ts — kept in sync manually)
// ---------------------------------------------------------------------------

export interface BrainMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  /** Name of the tool that produced this result (present when role === 'tool'). */
  toolName?: string;
}

export interface BrainRequest {
  messages: BrainMessage[];
  model?: string;
  tools?: ToolSchema[];
  race?: boolean;
  source?: string;
}

export interface BrainResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error';
  model: string;
  /** Token usage reported by the provider (optional — not all paths populate this). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  /**
   * Resolved sampling params actually used (temperature + max output tokens;
   * `seed` only when pinned). Surfaced by Brain for deterministic replay capture
   * — see the brain-call recording in loop.ts. Optional: not all return paths
   * (e.g. negative-router blocks) populate it.
   */
  sampling?: { temperature: number; maxTokens: number; seed?: number };
}

export interface ToolContext {
  sessionId: string;
  workingDir: string;
  config: unknown;
  logger: unknown;
  /** Abort signal forwarded from the registry's timeout controller. */
  signal?: AbortSignal;
  /**
   * Sandbox policy for the session. When enabled, shell-exec routes through bwrap.
   * Type-only inline import — erased at compile time; safe before sandbox-types.ts exists.
   */
  sandboxPolicy?: import('../sandbox/sandbox-types.js').SandboxPolicy;
  /**
   * Absolute path to the provisioned per-session workspace directory.
   * Falls back to workingDir when sandboxManager is absent.
   */
  workspaceDir?: string;
}

export interface BrainLike {
  call(req: BrainRequest): Promise<BrainResponse>;
  /**
   * Optional chat-style entry point. Real Brain class has it (returns the
   * raw assistant text); duck-typed mocks may not. Callers must guard.
   */
  chat?(
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>,
    model?: string,
  ): Promise<string>;
}

/** Minimal tool descriptor shape used by the smart tool router. */
export interface ToolDescriptor {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
  /** Declared safety level — 'destructive' tools never run in parallel. */
  safety?: 'readonly' | 'destructive';
  /** Confirmation-gated tools never run in parallel. */
  requiresConfirmation?: boolean;
}

export interface ToolRegistryLike {
  execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<{ success: boolean; output: string }>;
  getSchemaForLLM(): ToolSchema[];
  /** Return whether a tool requires user confirmation before execution. */
  requiresConfirmation?(name: string): boolean;
  /**
   * Register a tool. Optional because some test/mock registries that
   * implement only the read-side surface don't need to accept new tools.
   * Real ToolRegistry instances always supply this.
   */
  register?(toolDef: unknown): void;
  // ---- Optional methods consumed by ToolRouter (smart routing) ----
  /** Return all enabled tools whose category matches the given string. */
  getByCategory?(category: string): ToolDescriptor[];
  /** Return every currently-enabled tool as slim descriptors. */
  listEnabled?(): ToolDescriptor[];
  /** Look up a single tool descriptor by name. */
  get?(name: string): ToolDescriptor | undefined;
  /** Return true if the named tool is registered and enabled. */
  isEnabled?(name: string): boolean;
}

export interface SessionLike {
  id: string;
  messages: BrainMessage[];
  /** Originating channel for approval routing (e.g. "telegram"). */
  channel?: string;
  /** Originating peer/user ID for approval routing. */
  peerId?: string;
  /**
   * Ad-hoc session metadata stored by the agent loop for next-turn priming
   * (e.g. _feedbackTierAdjustment, _consciousnessEndContext). Keyed loosely
   * because these fields are written/read dynamically and are not persisted
   * inline. `unknown` keeps reads type-safe (callers must narrow).
   */
  [key: string]: unknown;
}

export type Emitter = (event: AgentEvent) => void;

// ---------------------------------------------------------------------------
// HookEmitterLike — duck-typed (mirrors loop.ts declaration)
// ---------------------------------------------------------------------------

/**
 * Minimal hook-emission interface threaded into helpers to avoid circular imports.
 * Mirrors the declaration in loop.ts.
 */
export interface HookEmitterLike {
  emit(event: string, context: Record<string, unknown>): Promise<void>;
}

/**
 * Minimal contract the AgentLoop consumes from a verify-gate implementation.
 * Mirrors `ConfidenceGate.evaluate()` from verify-gate.ts so the helper does
 * not need to import the concrete class (keeps loop-helpers free of DB deps).
 */
export interface VerifyGateLike {
  evaluate(toolName: string): {
    decision: 'allow' | 'escalate' | 'unknown';
    confidence: number | null;
    threshold: number;
    samples: number;
    reason: string;
  };
}

/**
 * Minimal contract the AgentLoop consumes from a grounding-checker implementation
 * (slice 2 of the verify-gate campaign). Mirrors `GroundingChecker.check()` from
 * verify-gate-grounding.ts so this helper stays free of fs/Promise deps in its
 * type surface — concrete class is constructed in loop.ts.
 */
export interface GroundingCheckerLike {
  check(toolName: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    reason: string;
    checked?: 'edit-grounding' | 'file-reference-grounding';
    evidence?: Record<string, unknown>;
  }>;
}

/**
 * Minimal contract the AgentLoop consumes from a critic-pass implementation
 * (slice 3 of the verify-gate campaign). Mirrors `CriticPass.review()` from
 * verify-gate-critic.ts. Slice 3 is observable-only: the verdict ships out as
 * a hook event but does NOT block execution. Trigger 'grounding-failed' fires
 * an LLM critic call; 'low-confidence' short-circuits to a soft-skip.
 */
export interface CriticPassLike {
  review(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    trigger: 'grounding-failed' | 'low-confidence';
    confidence: number | null;
    threshold: number;
    evidence?: Record<string, unknown>;
  }): Promise<{
    invoked: boolean;
    verdict: 'approve' | 'reject' | 'skip';
    reason: string;
    rationale?: string;
  }>;
}

/**
 * Run the slice-3 critic and emit a structured hook event. Never throws —
 * critic-internal failures are reported as `verify_gate_critic_error` so a
 * flaky critic can never brick the loop.
 *
 * Slice 4: returns the critic's result (or `null` on the throw-path) so the
 * caller can inspect a `'reject'` verdict and prepend agent-facing feedback
 * to the tool result it persists. The hook contract is unchanged.
 */
async function runCriticPass(
  critic: CriticPassLike,
  input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    trigger: 'grounding-failed' | 'low-confidence';
    confidence: number | null;
    threshold: number;
    evidence?: Record<string, unknown>;
  },
  hooks: HookEmitterLike | undefined,
): Promise<Awaited<ReturnType<CriticPassLike['review']>> | null> {
  let result: Awaited<ReturnType<CriticPassLike['review']>>;
  try {
    result = await critic.review(input);
  } catch (err) {
    log.warn(
      { tool: input.toolName, sessionId: input.sessionId, err: String(err) },
      'verify-gate: critic.review threw — failing open',
    );
    void safeEmit(hooks, 'verify_gate_critic_error', {
      sessionId: input.sessionId,
      toolName: input.toolName,
      trigger: input.trigger,
      err: String(err),
    });
    return null;
  }

  const baseCtx = {
    sessionId: input.sessionId,
    toolName: input.toolName,
    trigger: input.trigger,
    confidence: input.confidence,
    threshold: input.threshold,
  };

  if (!result.invoked) {
    const event = result.reason === 'budget-exhausted'
      ? 'verify_gate_critic_budget_exhausted'
      : result.reason === 'error' || result.reason === 'malformed'
        ? 'verify_gate_critic_error'
        : 'verify_gate_critic_skipped';
    // `rationale` on the budget-exhausted path carries an `errors=K/N` breakdown
    // from CriticPass so ops can distinguish "budget burned by real reviews"
    // from "budget burned by a flaky provider". Other skip reasons leave it null.
    void safeEmit(hooks, event, {
      ...baseCtx,
      reason: result.reason,
      rationale: result.rationale ?? null,
    });
    return result;
  }

  log.info(
    { tool: input.toolName, sessionId: input.sessionId, verdict: result.verdict, trigger: input.trigger },
    'verify-gate: critic verdict',
  );
  // Awaited so subscribers registered on both `verify_gate_critic_invoked`
  // and `verify_gate_critic_blocked` see them in invoked → blocked order
  // even when their handlers yield internally. HookEmitter.emit awaits each
  // handler sequentially, so awaiting here means every invoked handler has
  // run to completion before the caller fires the follow-up blocked event.
  await safeEmit(hooks, 'verify_gate_critic_invoked', {
    ...baseCtx,
    verdict: result.verdict,
    rationale: result.rationale ?? null,
  });
  return result;
}

/**
 * Fire a hook event without letting hook errors propagate.
 * Any exception is swallowed so a bad hook never crashes the agent loop.
 */
async function safeEmit(
  hooks: HookEmitterLike | undefined,
  event: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!hooks) return;
  try {
    await hooks.emit(event, { event, ...context });
  } catch (err) {
    log.warn({ event, err: String(err) }, 'hook emission error — continuing');
  }
}

// ---------------------------------------------------------------------------
// Layer 4 — Context collapse: intelligent tool result compression
// ---------------------------------------------------------------------------

/**
 * Intelligently compress verbose tool results instead of dumb truncation.
 * Recognises high-noise patterns (tsc errors, file listings, search results)
 * and replaces them with compact summaries that preserve the signal.
 */
function collapseToolResults(messages: BrainMessage[]): BrainMessage[] {
  return messages.map((msg): BrainMessage => {
    if (msg.role !== 'tool') return msg;

    const content = msg.content;
    if (typeof content !== 'string' || content.length <= 2000) return msg;

    const collapsed = collapseContent(content, msg.toolName ?? '');
    if (collapsed !== content) {
      log.debug({ tool: msg.toolName, before: content.length, after: collapsed.length }, 'Layer 4: tool result collapsed');
    }
    return { ...msg, content: collapsed };
  });
}

function collapseContent(content: string, toolName: string): string {
  const MAX = 3000;
  if (content.length <= MAX) return content;

  // Pattern 1: TypeScript error lists (tsc output)
  if (toolName.includes('typecheck') || content.includes('error TS')) {
    const errorLines = content.split('\n').filter(l => l.includes('error TS'));
    if (errorLines.length > 0) {
      const summary = `[TypeScript: ${errorLines.length} error(s)]\n${errorLines.slice(0, 10).join('\n')}${errorLines.length > 10 ? `\n... +${errorLines.length - 10} more` : ''}`;
      return summary;
    }
  }

  // Pattern 2: File listings / directory trees
  if (toolName.includes('glob') || toolName.includes('list') || toolName.includes('map')) {
    const lines = content.split('\n');
    if (lines.length > 40) {
      return `[${lines.length} items]\n${lines.slice(0, 30).join('\n')}\n... +${lines.length - 30} more`;
    }
  }

  // Pattern 3: Search results (grep)
  if (toolName.includes('grep') || toolName.includes('search')) {
    const lines = content.split('\n');
    if (lines.length > 50) {
      return `[${lines.length} matches]\n${lines.slice(0, 25).join('\n')}\n... +${lines.length - 25} more`;
    }
  }

  // Pattern 4: Large file read contents
  if (toolName.includes('read') || toolName.includes('multi')) {
    if (content.length > MAX) {
      return content.slice(0, MAX) + `\n\n[...${content.length - MAX} chars collapsed — use targeted read with line range if needed]`;
    }
  }

  // Default: hard cap at MAX
  return content.slice(0, MAX) + `\n\n[...${content.length - MAX} chars truncated]`;
}

// ---------------------------------------------------------------------------
// Compaction helper
// ---------------------------------------------------------------------------

/**
 * Run context compaction on a session and replace its message history.
 *
 * @param brain   - Brain-like object used to produce the summary.
 * @param session - Session whose messages will be compacted.
 * @param state   - Agent state (isCompacting flag updated in place).
 * @param emit    - Event emitter for compaction event.
 * @param hooks   - Optional hook emitter for lifecycle events.
 * @returns The compaction summary string, or '' on failure.
 */
export async function runCompaction(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
  emit: Emitter,
  hooks?: HookEmitterLike,
): Promise<string> {
  state.isCompacting = true;

  log.info({ sessionId: state.sessionId, messageCount: session.messages.length }, 'Compacting context');

  // PRE-COMPACTION FLUSH (covers the finishReason === 'length' path that skips prepareMessages).
  // The flush message is appended to the history that compact() summarises, so the summary
  // produced by the LLM will include "save important facts" as an action item — prompting the
  // agent to persist context on the very next turn after compaction.
  if (PRE_COMPACTION_FLUSH && !hasFlushReminder(session.messages as BrainMessage[])) {
    session.messages.push({ role: 'system', content: MEMORY_FLUSH_MESSAGE });
    log.info(
      { sessionId: state.sessionId },
      'Pre-compaction flush reminder appended before compact() call',
    );
  }

  const hookBase = { sessionId: state.sessionId };
  await safeEmit(hooks, 'before_compaction', hookBase);
  await safeEmit(hooks, 'session:compact:before', hookBase);

  let compactionSucceeded = false;
  try {
    const summary = await compact(brain, session.messages);
    compactionSucceeded = true;

    session.messages = [
      { role: 'system', content: `[Context compacted]\n\n${summary}` },
    ];

    emit({ type: 'compaction', summary });
    log.info({ sessionId: state.sessionId, summaryLen: summary.length }, 'Compaction complete');

    await safeEmit(hooks, 'after_compaction', hookBase);
    await safeEmit(hooks, 'session:compact:after', hookBase);
    await safeEmit(hooks, 'session:compact:patch', { ...hookBase, patch: summary });

    return summary;
  } catch (err) {
    log.error({ sessionId: state.sessionId, err }, 'Compaction failed — continuing without compaction');
    emit({ type: 'error', error: `Compaction failed: ${String(err)}` });
    if (!compactionSucceeded) {
      await safeEmit(hooks, 'after_compaction', { ...hookBase, meta: { status: 'failed' } });
      await safeEmit(hooks, 'session:compact:after', { ...hookBase, meta: { status: 'failed' } });
    }
    return '';
  } finally {
    state.isCompacting = false;
  }
}

// ---------------------------------------------------------------------------
// Duck-typed SecurityGuard interface (avoids circular imports)
// ---------------------------------------------------------------------------

export interface SecurityGuardLike {
  validateToolCall(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason?: string };
  logSecurityEvent(event: {
    type: string;
    userId: string;
    details: string;
    severity: string;
    timestamp: string;
  }): void;
  /** Optional prompt-injection check. Not all guard implementations carry it. */
  detectInjection?(message: string): { safe: boolean; threat: string | null; score: number };
}

// ---------------------------------------------------------------------------
// SandboxManagerLike — duck-typed to avoid circular imports
// ---------------------------------------------------------------------------

/**
 * Minimal interface that loop-helpers needs from SandboxManager.
 * Avoids importing the concrete class from Builder A's files directly.
 * The real SandboxManager must implement at minimum these methods.
 */
export interface SandboxManagerLike {
  /** Provision workspace directory for sessionId, returns absolute path. */
  provision(sessionId: string): Promise<string>;
  /** Return the provisioned workspace directory for the given sessionId. */
  getWorkspaceDir(sessionId: string): string;
  /** Return the merged sandbox policy for the given sessionId. */
  getPolicyFor(sessionId: string): import('../sandbox/sandbox-types.js').SandboxPolicy;
}

// ---------------------------------------------------------------------------
// Phase 2 polish: duck-typed Likes for injected FeedbackMemory
// (defined here to keep loop-helpers self-contained; mirrors other *Like patterns above)
// ---------------------------------------------------------------------------

export interface FeedbackMemoryLike {
  /** Matches real FeedbackMemory.recordSuccess(toolName, input, outcome, score?, sessionId?) */
  recordSuccess(
    toolName: string,
    input: unknown,
    outcome: string,
    score?: number,
    sessionId?: string,
  ): unknown;
  /** Matches real FeedbackMemory.recordFailure(toolName, input, error, sessionId?) */
  recordFailure(
    toolName: string,
    input: unknown,
    error: string,
    sessionId?: string,
  ): unknown;
}

// ---------------------------------------------------------------------------
// Phase 3 strict intra-file dedup (smallest win per plan; no new files)
// Dedups the identical feedback guard blocks added in P2 (>5 repeated lines).
// Kept private to this module; called from executeSingleToolCall only.
// ---------------------------------------------------------------------------

function guardedRecordFeedback(
  fb: FeedbackMemoryLike | undefined,
  success: boolean,
  toolName: string,
  input: unknown,
  outcomeOrErr: string,
  sessionId?: string,
): void {
  if (!fb || process.env['SUDO_FEEDBACK_DISABLE'] === '1') return;
  try {
    if (success) {
      fb.recordSuccess(toolName, input, outcomeOrErr || 'success', 0.8, sessionId);
    } else {
      fb.recordFailure(toolName, input, outcomeOrErr, sessionId);
    }
  } catch (fbErr) {
    log.warn({ err: String(fbErr), tool: toolName, sessionId }, `FeedbackMemory.record${success ? 'Success' : 'Failure'} failed — continuing`);
  }
}

// ---------------------------------------------------------------------------
// Parallel tool-call execution helpers (Upgrade 5)
// ---------------------------------------------------------------------------

/**
 * Tool name prefixes that mutate shared state and must always run sequentially.
 * Namespace prefixes (trailing dot) block every tool in that namespace:
 * `system.` and `code.` execute arbitrary commands, and `browser.`/`sandbox.`
 * tools share one stateful session, so even nominally read-only members are
 * order-dependent. Generic names (file./shell./db.) are kept for synthesized
 * and MCP tools that follow those conventions.
 */
const SEQUENTIAL_TOOL_PREFIXES: readonly string[] = [
  'system.', 'code.', 'browser.', 'sandbox.',
  'coder.write-file', 'coder.edit-file', 'coder.multi-edit', 'coder.smart-edit',
  'coder.apply-patch', 'coder.notebook-edit', 'coder.scaffold', 'coder.git',
  'coder.npm', 'coder.test',
  'file.write', 'file.delete', 'file.move', 'file.rename',
  'shell.', 'db.write', 'db.insert', 'db.update', 'db.delete',
  'memory.save', 'memory.delete',
];

/**
 * Return true when a tool call can run concurrently with others.
 * Sequential when it has a mutating prefix, declares `safety: 'destructive'`
 * or `requiresConfirmation` in the registry, or shares a `path` arg with
 * another call in the same batch.
 *
 * Exported with underscore prefix to signal "internal, test-only".
 */
export function _isParallelSafe(
  tc: { name: string; arguments: Record<string, unknown> },
  allCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>,
  registry?: Pick<ToolRegistryLike, 'get'>,
): boolean {
  const nameL = tc.name.toLowerCase();
  for (const prefix of SEQUENTIAL_TOOL_PREFIXES) {
    if (nameL.startsWith(prefix)) return false;
  }
  const def = registry?.get?.(tc.name);
  if (def && (def.safety === 'destructive' || def.requiresConfirmation === true)) return false;
  const myPath = tc.arguments['path'] as string | undefined;
  if (myPath) {
    const conflicts = allCalls.filter(
      other => other !== tc && (other.arguments['path'] as string | undefined) === myPath,
    );
    if (conflicts.length > 0) return false;
  }
  return true;
}

/** Partition calls: leading sequential → one parallel batch → trailing sequential. */
interface PartitionResult {
  leadingSequential: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  parallel: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  trailingSequential: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/** Exported with underscore prefix to signal "internal, test-only". */
export function _partitionToolCalls(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  registry?: Pick<ToolRegistryLike, 'get'>,
): PartitionResult {
  if (calls.length <= 1 || process.env['SUDO_PARALLEL_TOOLS_DISABLE'] === '1') {
    return { leadingSequential: calls, parallel: [], trailingSequential: [] };
  }
  const safeFlags = calls.map(tc => _isParallelSafe(tc, calls, registry));
  const firstSafe = safeFlags.indexOf(true);
  if (firstSafe === -1) {
    return { leadingSequential: calls, parallel: [], trailingSequential: [] };
  }
  let lastSafe = firstSafe;
  while (lastSafe + 1 < calls.length && safeFlags[lastSafe + 1]) lastSafe++;
  return {
    leadingSequential: calls.slice(0, firstSafe),
    parallel: calls.slice(firstSafe, lastSafe + 1),
    trailingSequential: calls.slice(lastSafe + 1),
  };
}

const DEFAULT_TOOL_CONCURRENCY = 10;

/** Parallel-batch concurrency cap from SUDO_TOOL_CONCURRENCY (default 10, min 1). */
function getToolConcurrency(): number {
  const raw = Number(process.env['SUDO_TOOL_CONCURRENCY']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOOL_CONCURRENCY;
}

interface SingleCallResult {
  tc: { id: string; name: string; arguments: Record<string, unknown> };
  resultContent: string;
  /**
   * Slice-4 carrier: when the critic returned a `'reject'` verdict for this
   * call AND `SUDO_VERIFY_GATE_CRITIC_FEEDBACK=1` is set, the `commit` closure
   * prepends this string to the tool message that lands in session history so
   * the model sees the criticism on its next turn. Undefined on every other
   * path (no critic wired / skipped / approved / env flag off).
   */
  criticFeedback?: string;
  /**
   * Recovery-reader carrier: when this call FAILED and a `preventionLookup`
   * surfaced a known prevention rule / solution for the same tool+error, the
   * `commit` closure prepends this string to the tool message in session
   * history so the model sees the prior lesson before it retries. Undefined on
   * success, when no lookup is wired, or when nothing is on record.
   */
  preventionHint?: string;
}

/**
 * Looks up a prior-failure prevention hint for a (tool, error) pair. Returns a
 * model-facing hint string, or null when nothing is on record. Sourced from
 * ToolOutcomeLearner.checkPreventionRulesForError; wired only when
 * SUDO_FAILURE_PREVENTION_HINT=1.
 */
export type PreventionLookupLike = (toolName: string, error: string) => string | null;

/**
 * Execute one tool call (security + permission gated) and return its result.
 * Does NOT touch session.messages — caller is responsible for appending.
 */
async function executeSingleToolCall(
  tc: { id: string; name: string; arguments: Record<string, unknown> },
  ctx: ToolContext,
  emit: Emitter,
  toolRegistry: ToolRegistryLike,
  security?: SecurityGuardLike,
  feedbackMemory?: FeedbackMemoryLike,
  verifyGate?: VerifyGateLike,
  hooks?: HookEmitterLike,
  groundingChecker?: GroundingCheckerLike,
  groundingBlockEnabled: boolean = false,
  criticPass?: CriticPassLike,
  preventionLookup?: PreventionLookupLike,
): Promise<SingleCallResult> {
  emit({ type: 'tool-call', name: tc.name, args: tc.arguments, toolId: tc.id });
  log.info({ tool: tc.name, toolCallId: tc.id, sessionId: ctx.sessionId }, 'Executing tool call');

  // Slice-4 carrier. Populated by the criticPass branch below on a
  // `'reject'` verdict when SUDO_VERIFY_GATE_CRITIC_FEEDBACK=1. The
  // `commit` closure in executeToolCalls reads it back to prepend
  // agent-facing feedback to the tool message stored in session history.
  let criticFeedback: string | undefined;

  if (security) {
    const secResult = security.validateToolCall(tc.name, tc.arguments ?? {});
    if (!secResult.allowed) {
      const blockedMsg = `[SecurityGuard] Tool call blocked: ${tc.name} — ${secResult.reason ?? 'policy violation'}`;
      log.warn({ tool: tc.name, reason: secResult.reason, sessionId: ctx.sessionId }, 'Tool call blocked by security');
      emit({ type: 'tool-result', name: tc.name, result: blockedMsg, toolId: tc.id, success: false });
      return { tc, resultContent: blockedMsg };
    }
  }

  const permMode = PermissionManager.getInstance().check(tc.name);
  if (permMode === 'deny') {
    const deniedMsg = `[PermissionManager] Tool execution permanently denied: ${tc.name}`;
    log.warn({ tool: tc.name, sessionId: ctx.sessionId }, deniedMsg);
    emit({ type: 'tool-result', name: tc.name, result: deniedMsg, toolId: tc.id, success: false });
    return { tc, resultContent: deniedMsg };
  }

  // Verify-gate (slice 1: confidence dispatcher + slice 2: grounding check).
  //
  // Slice 1 still emits 'verify_gate_escalated' on every low-confidence
  // destructive call. Slice 2 layers a grounding pass on top: when escalation
  // fires AND a grounding checker is wired, re-read the target file (or stat
  // a referenced path) BEFORE the tool runs. By default the result is
  // observable-only (logged + emitted as 'verify_gate_grounding_failed'),
  // matching slice 1's caution; opt-in `SUDO_VERIFY_GATE_BLOCK=1` upgrades
  // a mismatch to a hard block with the same structured shape as the
  // security/permission blocks above.
  if (verifyGate) {
    try {
      const gate = verifyGate.evaluate(tc.name);
      if (gate.decision === 'escalate') {
        log.warn(
          { tool: tc.name, confidence: gate.confidence, threshold: gate.threshold, samples: gate.samples, sessionId: ctx.sessionId },
          'verify-gate: escalation signaled',
        );
        void safeEmit(hooks, 'verify_gate_escalated', {
          sessionId: ctx.sessionId,
          toolName: tc.name,
          confidence: gate.confidence,
          threshold: gate.threshold,
          samples: gate.samples,
          reason: gate.reason,
        });

        let groundingFailedObservable = false;
        let lastGroundingEvidence: Record<string, unknown> | undefined;
        if (groundingChecker) {
          let grounding: Awaited<ReturnType<GroundingCheckerLike['check']>> | null = null;
          let groundingThrew = false;
          try {
            grounding = await groundingChecker.check(tc.name, tc.arguments ?? {});
          } catch (err) {
            groundingThrew = true;
            log.warn({ tool: tc.name, err: String(err) }, 'verify-gate: grounding check threw — failing open');
            // Distinguish "checker threw" from "no checker wired" for slice-3
            // consumers and ops dashboards — both produce a silent pass-through
            // without this event.
            void safeEmit(hooks, 'verify_gate_grounding_error', {
              sessionId: ctx.sessionId,
              toolName: tc.name,
              err: String(err),
            });
          }
          if (!groundingThrew && grounding && !grounding.ok) {
            // Resolve effective block flag live: the param wired in by
            // setGroundingChecker(checker, blockOnFail) was a one-shot
            // snapshot at attach time, leaving SUDO_VERIFY_GATE_BLOCK
            // asymmetric with the live-read critic flags
            // (SUDO_VERIFY_GATE_CRITIC_BLOCK, ..._CRITIC_FEEDBACK). OR
            // against the live env so an operator who flips the flag
            // mid-process sees the new behaviour on the next call without
            // re-attaching the checker. The explicit param remains a
            // code-level forced enable (true wins) — a test or hardened
            // deployment that wants the block on regardless of env still
            // gets it.
            const effectiveBlock = groundingBlockEnabled || isGroundingBlockEnabled(process.env);
            log.warn(
              { tool: tc.name, reason: grounding.reason, checked: grounding.checked, evidence: grounding.evidence, sessionId: ctx.sessionId, block: effectiveBlock },
              'verify-gate: grounding mismatch',
            );
            // `confidence` + `threshold` are carried here so a slice-3 critic
            // consumer can act on grounding failures without correlating
            // back to `verify_gate_escalated` by session+tool+timestamp.
            void safeEmit(hooks, 'verify_gate_grounding_failed', {
              sessionId: ctx.sessionId,
              toolName: tc.name,
              reason: grounding.reason,
              checked: grounding.checked ?? null,
              evidence: grounding.evidence ?? null,
              blocked: effectiveBlock,
              confidence: gate.confidence,
              threshold: gate.threshold,
            });
            if (effectiveBlock) {
              // Precedence — block-over-critic-over-feedback. The
              // grounding-block path short-circuits BEFORE the slice-3
              // critic runs, so neither the slice-4 agent-facing feedback
              // nor the slice-5 critic-reject block ever fires when
              // grounding has already blocked the call. Mirrors the
              // explicit precedence comment at slice 5's block-vs-feedback
              // branch below: when a stronger signal wins, drop the
              // weaker signals so the agent sees one clean reason.
              // `verify_gate_grounding_failed` (already emitted above with
              // `blocked: true`) is the sole correlator event subscribers
              // get for this path.
              const blockedMsg = `[VerifyGate] Tool call blocked: ${tc.name} — grounding mismatch (${grounding.reason})`;
              emit({ type: 'tool-result', name: tc.name, result: blockedMsg, toolId: tc.id, success: false });
              return { tc, resultContent: blockedMsg };
            }
            // Observable-only mismatch — slice-3 critic gets the strong trigger.
            groundingFailedObservable = true;
            lastGroundingEvidence = {
              reason: grounding.reason,
              checked: grounding.checked ?? null,
              ...(grounding.evidence ?? {}),
            };
          }
        }

        // Slice 3 — auto-critic. Reached only when the grounding block above
        // did NOT short-circuit return. The critic runs at most once per
        // escalated call, awaited so the verdict event lands in the same
        // turn the agent can see on the next iteration. Strictly observable:
        // verdict never blocks execution.
        //
        // Slice 4 — agent-facing feedback. When the critic returns a
        // `'reject'` verdict AND `SUDO_VERIFY_GATE_CRITIC_FEEDBACK=1` is set,
        // capture the rationale here; the `commit` closure in
        // executeToolCalls prepends it to the tool message that lands in
        // session history so the model sees the criticism on its next turn.
        // Brain.toSDKMessages drops mid-conversation system messages, so the
        // tool-result channel is the only carrier already plumbed end-to-end
        // to the model that we can piggy-back on.
        if (criticPass) {
          const trigger: 'grounding-failed' | 'low-confidence' =
            groundingFailedObservable ? 'grounding-failed' : 'low-confidence';
          const criticResult = await runCriticPass(
            criticPass,
            {
              sessionId: ctx.sessionId,
              toolName: tc.name,
              args: tc.arguments ?? {},
              trigger,
              confidence: gate.confidence,
              threshold: gate.threshold,
              ...(lastGroundingEvidence ? { evidence: lastGroundingEvidence } : {}),
            },
            hooks,
          );
          // Slice 5 — critic-reject hard block (opt-in
          // SUDO_VERIFY_GATE_CRITIC_BLOCK=1). Closes the campaign's last
          // "soft → hard" gradient: when the critic actually invoked AND
          // returned 'reject' AND the operator opted in, refuse the call
          // before `toolRegistry.execute` runs. Same block shape slice 2
          // uses for grounding mismatches so downstream observers
          // (alignment digest, alert routers) catch both block paths with
          // one regex. Soft-skips / errors / approvals never block —
          // matches slice 3's deliberately observable contract for the
          // weaker signals.
          //
          // Block precedence over slice-4 feedback: when block fires,
          // the block MESSAGE itself names the critic rejection, so
          // prepending the `[VERIFY-GATE CRITIC REJECT]` line on top
          // would be doubly redundant. Drop slice-4 feedback when slice
          // 5 wins so the agent sees one clean signal.
          if (
            criticResult
            && criticResult.invoked
            && criticResult.verdict === 'reject'
            && readCriticBlockEnabled(process.env)
          ) {
            const blockedMsg = renderCriticBlockMessage(tc.name, criticResult.rationale);
            log.warn(
              { tool: tc.name, sessionId: ctx.sessionId, rationale: criticResult.rationale },
              'verify-gate slice 5: critic reject — hard block',
            );
            // Slice 6 — dedicated `verify_gate_critic_blocked` correlator event.
            // Slice 5 only stored the structured `[VerifyGate] Tool call
            // blocked` message in session history; alert routers had to
            // regex-match the message shape to detect block enforcement.
            // This event closes that gap: it carries the same correlator
            // fields as `verify_gate_critic_invoked` (already fired by
            // runCriticPass above) plus the literal block message so
            // subscribers don't reconstruct it.
            // Awaited so the ordering guarantee from runCriticPass extends
            // through here: `verify_gate_critic_invoked` handlers have all
            // run to completion before `verify_gate_critic_blocked` fires,
            // even for async subscribers that yield internally. Order is
            // observable on hook listeners, not just on the in-process
            // events array.
            // No new env flag — event presence is already env-gated by
            // SUDO_VERIFY_GATE_CRITIC_BLOCK=1 (this branch only runs when
            // the operator opted into the hard block).
            await safeEmit(hooks, 'verify_gate_critic_blocked', {
              sessionId: ctx.sessionId,
              toolName: tc.name,
              trigger,
              confidence: gate.confidence,
              threshold: gate.threshold,
              rationale: criticResult.rationale ?? null,
              message: blockedMsg,
            });
            emit({ type: 'tool-result', name: tc.name, result: blockedMsg, toolId: tc.id, success: false });
            return { tc, resultContent: blockedMsg };
          }

          if (
            criticResult
            && criticResult.invoked
            && criticResult.verdict === 'reject'
            && readCriticFeedbackEnabled(process.env)
          ) {
            criticFeedback = renderCriticFeedback(criticResult.rationale);
            log.info(
              { tool: tc.name, sessionId: ctx.sessionId },
              'verify-gate slice 4: critic reject — feedback queued for next turn',
            );
          }
        }
      } else {
        // Success-path event — closes the audit LOW where subscribers could
        // not tell apart "gate ran and was happy" from "no verify-gate wired
        // / SUDO_VERIFY_GATE off". Symmetric correlator fields with
        // `verify_gate_escalated` so a single observer can union both events
        // on (sessionId, toolName) without conditional payload handling.
        // Volume note: subscribers writing one row per event to a
        // high-cardinality backend will see roughly one extra event per
        // non-escalated destructive tool call when SUDO_VERIFY_GATE=1.
        void safeEmit(hooks, 'verify_gate_evaluated_ok', {
          sessionId: ctx.sessionId,
          toolName: tc.name,
          decision: gate.decision,
          confidence: gate.confidence,
          threshold: gate.threshold,
          samples: gate.samples,
          reason: gate.reason,
        });
      }
    } catch (err) {
      log.warn({ tool: tc.name, err: String(err) }, 'verify-gate: evaluate threw — failing open');
    }
  }

  let resultContent: string;
  // Recovery-reader: the error string of a failed call, used to look up a
  // prior-failure prevention hint just before the final return.
  let callError: string | undefined;
  try {
    const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
      ? tc.arguments
      : {};
    const result = await toolRegistry.execute(tc.name, safeArgs, ctx);
    // Central size cap before the output re-enters the model context — guards
    // against a single un-truncated tool result (large scrape/MCP/file) blowing
    // up context. The clamped string is what the model sees AND what the trace
    // captures, so a replay reproduces exactly what drove the run.
    resultContent = clampToolOutput(typeof result.output === 'string' ? result.output : String(result.output ?? ''));
    // Forward the tool's authoritative success so outcome sinks (ToolOutcomeLearner,
    // SkillDiscovery, TraceStore, after:tool-call) don't re-guess it from the output string.
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id, success: result.success });
    log.info({ tool: tc.name, success: result.success }, 'Tool call completed');
    guardedRecordFeedback(feedbackMemory, true, tc.name, tc.arguments ?? {}, resultContent || 'success', ctx.sessionId);
    // A tool can report failure via its authoritative `success` flag without throwing.
    if (!result.success) callError = resultContent;
  } catch (err) {
    if (err instanceof ToolError && err.code === 'tool_not_found') {
      log.warn({ tool: tc.name }, 'Tool not found — invoking fallback chain');
      const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
        ? tc.arguments
        : {};
      const fallbackResult = clampToolOutput(await _toolNotFoundFallback(tc.name, safeArgs, toolRegistry, ctx));
      emit({ type: 'tool-result', name: tc.name, result: fallbackResult, toolId: tc.id });
      // Slice-4: even on tool_not_found the critic verdict (if any) was
      // about the *call the agent planned*, so it's still informative for
      // the next-turn replanning. Surface it.
      return { tc, resultContent: fallbackResult, ...(criticFeedback ? { criticFeedback } : {}) };
    }
    resultContent = `Error executing tool ${tc.name}: ${String(err)}`;
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id, success: false });
    log.error({ tool: tc.name, err }, 'Tool call failed');
    guardedRecordFeedback(feedbackMemory, false, tc.name, tc.arguments ?? {}, resultContent || String(err), ctx.sessionId);
    callError = resultContent;
  }

  // Recovery-reader: if this call failed and a prior recovery for the same
  // tool+error is on record, surface the lesson so the model sees it before
  // retrying. Fail-open — a throwing lookup must not break the tool path.
  let preventionHint: string | undefined;
  if (callError && preventionLookup) {
    try {
      preventionHint = preventionLookup(tc.name, callError) ?? undefined;
    } catch (err) {
      log.warn({ tool: tc.name, err: String(err) }, 'preventionLookup threw — skipping hint');
    }
  }

  return {
    tc,
    resultContent,
    ...(criticFeedback ? { criticFeedback } : {}),
    ...(preventionHint ? { preventionHint } : {}),
  };
}

/**
 * 3-step fallback chain for `tool_not_found` errors.
 *
 * Exported with underscore prefix to signal "internal, test-only" while
 * remaining importable from tests without extra indirection.
 *
 * Each step is isolated in its own try/catch so a failure (including
 * `tool_not_found` on the meta-tools themselves, which do not yet exist
 * until P2-c ships) simply advances to the next step.
 *
 * @param toolName - Name of the tool that was not found.
 * @param args     - Arguments that were passed to the missing tool.
 * @param registry - The active tool registry.
 * @param ctx      - Tool execution context.
 * @returns A human-readable string: search results, synthesis confirmation,
 *          or a "could not be auto-resolved" fallback message.
 */
export async function _toolNotFoundFallback(
  toolName: string,
  args: Record<string, unknown>,
  registry: ToolRegistryLike,
  ctx: ToolContext,
): Promise<string> {
  // Step (a): search MCP catalog for the missing tool.
  try {
    const result = await registry.execute('tool.search-mcp-catalog', { query: toolName }, ctx);
    if (result.success && result.output && result.output.trim().length > 0) {
      log.info({ tool: toolName }, 'Fallback: resolved via tool.search-mcp-catalog');
      return result.output;
    }
  } catch (_searchErr) {
    log.debug({ tool: toolName, err: String(_searchErr) }, 'Fallback step (a) failed — advancing');
  }

  // Step (b): search npm registry for a package that provides the capability.
  try {
    const result = await registry.execute('tool.search-npm', { query: toolName }, ctx);
    if (result.success && result.output && result.output.trim().length > 0) {
      log.info({ tool: toolName }, 'Fallback: resolved via tool.search-npm');
      return result.output;
    }
  } catch (_npmErr) {
    log.debug({ tool: toolName, err: String(_npmErr) }, 'Fallback step (b) failed — advancing');
  }

  // Step (c): synthesize a new tool definition on the fly.
  try {
    const result = await registry.execute(
      'tool.synthesize',
      { toolName, args: JSON.stringify(args) },
      ctx,
    );
    if (result.success && result.output && result.output.trim().length > 0) {
      log.info({ tool: toolName }, 'Fallback: resolved via tool.synthesize');
      return result.output;
    }
  } catch (_synthErr) {
    log.debug({ tool: toolName, err: String(_synthErr) }, 'Fallback step (c) failed — advancing');
  }

  // Step (d): all steps exhausted.
  log.warn({ tool: toolName }, 'Fallback: all resolution steps failed');
  return `Tool not found and could not be auto-resolved: ${toolName}`;
}

/**
 * Execute all tool calls returned by the LLM and append result messages.
 *
 * Independent read-only tool calls run in parallel via Promise.all().
 * Mutating/conflicting calls (shell exec, same-path file writes, browser
 * interactions) always run sequentially to prevent race conditions.
 *
 * Execution order:
 *   1. Leading sequential block
 *   2. Parallel batch (safe concurrent tools)
 *   3. Trailing sequential block
 *
 * @param toolCalls      - Array of tool calls from the LLM response.
 * @param session        - Session to append tool-result messages to.
 * @param state          - Agent state (pendingToolCalls updated in place).
 * @param emit           - Event emitter.
 * @param toolRegistry   - Registry used to execute tools.
 * @param security       - Optional SecurityGuard for per-call validation.
 * @param brain          - Optional Brain reference passed into tool context.
 * @param hooks          - Optional hook emitter for lifecycle events.
 * @param sandboxManager - Optional SandboxManager for sandbox-aware workspace resolution.
 * @param feedbackMemory - Optional (Phase 2) for live recordSuccess/recordFailure at exec time.
 * @param verifyGate     - Optional slice-1 confidence dispatcher (verify-gate campaign).
 * @param groundingChecker - Optional slice-2 grounding checker. Co-dependency: only runs when `verifyGate` escalates.
 * @param groundingBlockEnabled - When true (SUDO_VERIFY_GATE_BLOCK=1), slice-2 grounding mismatch is a hard block.
 * @param criticPass     - Optional slice-3 auto-critic. Co-dependency: only runs when `verifyGate` escalates AND the call is not already grounding-blocked.
 *                         Slice 4 (SUDO_VERIFY_GATE_CRITIC_FEEDBACK=1) prepends a `'reject'` verdict's rationale
 *                         to the tool message in session history so the agent sees it next turn.
 */
export async function executeToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  session: SessionLike,
  state: AgentState,
  emit: Emitter,
  toolRegistry: ToolRegistryLike,
  security?: SecurityGuardLike,
  brain?: BrainLike,
  hooks?: HookEmitterLike,
  sandboxManager?: SandboxManagerLike,
  feedbackMemory?: FeedbackMemoryLike,
  verifyGate?: VerifyGateLike,
  groundingChecker?: GroundingCheckerLike,
  groundingBlockEnabled: boolean = false,
  criticPass?: CriticPassLike,
  preventionLookup?: PreventionLookupLike,
): Promise<void> {
  const policyFromSandbox = sandboxManager?.getPolicyFor(state.sessionId);
  // Provision workspace if sandboxManager is available — ensures directory exists before bwrap tries to mount it.
  let workspaceDir = sandboxManager?.getWorkspaceDir(state.sessionId) ?? process.cwd();
  if (sandboxManager) {
    try {
      workspaceDir = await sandboxManager.provision(state.sessionId);
    } catch (err) {
      log.warn({ sessionId: state.sessionId, err: String(err) }, 'Workspace provisioning failed — falling back to cwd');
      workspaceDir = process.cwd();
    }
  }
  const ctx: ToolContext = {
    sessionId: state.sessionId,
    workingDir: workspaceDir,
    workspaceDir,
    sandboxPolicy: policyFromSandbox,
    config: brain ? { brain } : null,
    logger: log,
  };

  // Defense-in-depth: if the environment declares sandbox is required but no
  // sandboxManager was wired in, log a warning so operators notice the gap.
  if (!sandboxManager && process.env['SANDBOX_REQUIRED'] === '1') {
    log.warn({ sessionId: state.sessionId }, 'sandboxManager not configured - tools execute unsandboxed');
  }

  state.pendingToolCalls = toolCalls.length;

  // Phase 0: validation + approval gate (must run sequentially — user interaction).
  const approvedCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const tc of toolCalls) {
    if (!tc.name || !tc.id) {
      log.warn({ tc }, 'Skipping malformed tool call (missing name or id)');
      state.pendingToolCalls--;
      continue;
    }

    // Pre-check deny-mode tools before showing an approval prompt.
    const permMode = PermissionManager.getInstance().check(tc.name);
    if (permMode === 'deny') {
      const deniedMsg = `[PermissionManager] Tool execution permanently denied: ${tc.name}`;
      log.warn({ tool: tc.name, sessionId: state.sessionId }, deniedMsg);
      emit({ type: 'tool-result', name: tc.name, result: deniedMsg, toolId: tc.id, success: false });
      session.messages.push({ role: 'tool', content: deniedMsg, toolCallId: tc.id, toolName: tc.name });
      state.pendingToolCalls--;
      continue;
    }

    const needsConfirmation = permMode !== 'auto'
      && typeof toolRegistry.requiresConfirmation === 'function'
      && toolRegistry.requiresConfirmation(tc.name);

    if (needsConfirmation) {
      const channel = session.channel ?? 'headless';
      const peerId = session.peerId ?? '';
      log.info({ tool: tc.name, channel, peerId }, 'Tool requires confirmation — requesting approval');
      const approved = await approvalManager.requestApproval(tc.name, tc.arguments ?? {}, channel, peerId);
      if (!approved) {
        const denied = `Tool execution denied by user: ${tc.name}`;
        log.warn({ tool: tc.name }, denied);
        emit({ type: 'tool-result', name: tc.name, result: denied, toolId: tc.id, success: false });
        session.messages.push({ role: 'tool', content: denied, toolCallId: tc.id, toolName: tc.name });
        state.pendingToolCalls--;
        continue;
      }
      log.info({ tool: tc.name }, 'Tool execution approved by user');
    }

    approvedCalls.push(tc);
  }

  // Append a result message and decrement the pending counter.
  const commit = (res: SingleCallResult): void => {
    // Slice-4: when the critic returned `'reject'` AND
    // SUDO_VERIFY_GATE_CRITIC_FEEDBACK=1 was set, prepend the rationale
    // to the tool message stored in session history so the model sees
    // the criticism on its next turn. The `tool-result` event already
    // fired with the raw output (see executeSingleToolCall) so telemetry
    // and stream observers still see the un-prefixed content — only the
    // model-facing history is annotated. `tool_result_persist` carries
    // the annotated content so a hook subscriber can correlate it with
    // the `verify_gate_critic_invoked` event.
    // Prepend agent-facing annotations to the model-facing history (outermost
    // first): the critic rejection, then the prior-failure prevention hint.
    // Both rarely co-occur (critic fires on reject/grounding; the hint fires on
    // an actual tool failure) but stacking is well-defined if they do.
    let stored = res.resultContent;
    if (res.preventionHint) stored = `${res.preventionHint}\n\n${stored}`;
    if (res.criticFeedback) stored = `${res.criticFeedback}\n\n${stored}`;
    // toolCallId and toolName MUST be present for the Vercel AI SDK to
    // correctly match tool results back to tool calls on the next LLM turn.
    session.messages.push({
      role: 'tool',
      content: stored,
      toolCallId: res.tc.id,
      toolName: res.tc.name,
    });
    state.pendingToolCalls--;
    // Fire-and-forget: tool_result_persist signals that the result is now in session history.
    void safeEmit(hooks, 'tool_result_persist', {
      sessionId: state.sessionId,
      toolName: res.tc.name,
      result: stored,
    });
  };

  // Phase 1: partition into sequential / parallel groups.
  const { leadingSequential, parallel, trailingSequential } = _partitionToolCalls(approvedCalls, toolRegistry);

  // Phase 2a: leading sequential block.
  for (const tc of leadingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled, criticPass, preventionLookup);
    commit(res);
  }

  // Phase 2b: parallel batch (two or more safe tools), capped per chunk.
  if (parallel.length > 1) {
    const cap = getToolConcurrency();
    log.info(
      { count: parallel.length, cap, tools: parallel.map(t => t.name) },
      'Running tool calls in parallel',
    );
    for (let i = 0; i < parallel.length; i += cap) {
      const chunk = parallel.slice(i, i + cap);
      const results = await Promise.all(
        chunk.map(tc => executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled, criticPass, preventionLookup)),
      );
      // Append in original order so the LLM context stays coherent.
      for (const res of results) commit(res);
    }
  } else if (parallel.length === 1) {
    const res = await executeSingleToolCall(parallel[0]!, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled, criticPass, preventionLookup);
    commit(res);
  }

  // Phase 2c: trailing sequential block.
  for (const tc of trailingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled, criticPass, preventionLookup);
    commit(res);
  }

  state.pendingToolCalls = 0;

  // Fire-and-forget: signals that every tool call in this turn has settled
  // (CC PostToolBatch parity) — lets hooks act once per batch instead of per call.
  void safeEmit(hooks, 'tool_batch_complete', {
    sessionId: state.sessionId,
    toolCount: toolCalls.length,
    parallelCount: parallel.length,
  });
}

// ---------------------------------------------------------------------------
// Pre-call preparation helper
// ---------------------------------------------------------------------------

/**
 * Optionally compact the session if context is approaching limits, then
 * trim oversized tool results. Returns the trimmed message array to send.
 *
 * @param brain    - Brain-like for compaction if needed.
 * @param session  - Session whose messages will be prepared.
 * @param state    - Agent state.
 * @param emit     - Event emitter.
 * @returns Trimmed copy of session messages ready for the LLM call.
 */
/**
 * System message text injected as a reminder for the agent to flush important
 * context to workspace/memory/ files before compaction replaces the history.
 */
const MEMORY_FLUSH_MESSAGE =
  'MEMORY FLUSH: Your context is about to be compacted. Save any important ' +
  'information from this conversation to workspace/memory/ files NOW using ' +
  'the write tool. Focus on: decisions made, problems solved, key facts ' +
  'learned, and any pending work.';

/**
 * Return true when a MEMORY FLUSH reminder is already present in the session.
 * Prevents re-injection on every iteration within the same outer loop turn.
 */
function hasFlushReminder(messages: BrainMessage[]): boolean {
  return messages.some((m) => typeof m.content === 'string' && m.content.startsWith('MEMORY FLUSH:'));
}

/**
 * Per-session autoCompact circuit-breaker counter. Keyed by the SessionLike
 * object reference so entries are GC'd automatically when the session goes
 * away — no manual cleanup, no leak in long-running PM2 processes.
 * Replaces the original module-level counter inside compaction.ts so a
 * misbehaving brain on session A can't disable autoCompact on session B.
 */
const autoCompactFailuresBySession: WeakMap<SessionLike, AutoCompactFailureCounter> = new WeakMap();

function getSessionFailureCounter(session: SessionLike): AutoCompactFailureCounter {
  let counter = autoCompactFailuresBySession.get(session);
  if (!counter) {
    counter = { count: 0 };
    autoCompactFailuresBySession.set(session, counter);
  }
  return counter;
}

/**
 * TIER 2 / TIER 3 compaction escalation (gap #14 deferred follow-up).
 *
 * Runs AFTER LAYER 1's brain-driven `compact()` summary. If the resulting
 * history is still over the `shouldCompact` threshold, escalates:
 *   TIER 2 → `autoCompact` (circuit-breaker-aware brain summary of the middle)
 *   TIER 3 → `fullCompact` (nuclear collapse: 1 system summary + last user)
 *
 * Mutates `session.messages` in place on success; fail-open on any throw so a
 * misbehaving brain never breaks the agent loop. Caller is expected to gate on
 * the `SUDO_COMPACT_ESCALATE=1` opt-in env flag before invoking.
 *
 * The autoCompact circuit-breaker counter is held PER-SESSION (WeakMap-backed)
 * so failure on one session never disables autoCompact for others.
 *
 * @internal exported for unit testing.
 */
export async function escalateCompaction(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
): Promise<void> {
  if (!shouldCompact(session.messages as Array<{ content: string }>)) {
    return;
  }
  const beforeTokens = estimateContextSize(session.messages as Array<{ content: string }>);
  const failureCounter = getSessionFailureCounter(session);

  // TIER 2 — autoCompact. brain.call shape is structurally compatible; cast
  // through unknown to satisfy TS's bivariant function-parameter check.
  try {
    const autoResult = await autoCompact(
      session.messages as Array<{ role: string; content: string }>,
      brain as unknown as Parameters<typeof autoCompact>[1],
      beforeTokens,
      MAX_CONTEXT_TOKENS,
      { failureCounter },
    );
    if (autoResult.compacted) {
      session.messages = autoResult.history as typeof session.messages;
      log.info(
        {
          sessionId: state.sessionId,
          beforeTokens,
          afterTokens: autoResult.tokensAfter,
        },
        'TIER 2: autoCompact applied (gap #14 deferred)',
      );
    }
  } catch (err) {
    log.warn(
      { sessionId: state.sessionId, err: String(err) },
      'TIER 2 autoCompact threw — falling through to TIER 3',
    );
  }

  // TIER 3 — fullCompact nuclear reset. Only if shouldCompact still true
  // after TIER 2 (autoCompact's circuit breaker can leave history untouched).
  if (!shouldCompact(session.messages as Array<{ content: string }>)) {
    return;
  }
  try {
    const fullResult = await fullCompact(
      session.messages as Array<{ role: string; content: string }>,
      brain as unknown as Parameters<typeof fullCompact>[1],
    );
    session.messages = fullResult as typeof session.messages;
    log.warn(
      {
        sessionId: state.sessionId,
        beforeTokens,
        afterMessages: fullResult.length,
      },
      'TIER 3: fullCompact nuclear reset applied (gap #14 deferred)',
    );
  } catch (err) {
    log.warn(
      { sessionId: state.sessionId, err: String(err) },
      'TIER 3 fullCompact threw — leaving history for LAYER 2/3 to handle',
    );
  }
}

export async function prepareMessages(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
  emit: Emitter,
  hooks?: HookEmitterLike,
): Promise<BrainMessage[]> {
  // LAYER 0 — PRE-COMPACTION FLUSH REMINDER
  // At 40 % of MAX_CONTEXT_TOKENS (below the 50 % shouldCompact threshold), inject a
  // system reminder so the agent has one full turn to write important context to
  // workspace/memory/ files before the history is replaced by a compaction summary.
  if (PRE_COMPACTION_FLUSH && !hasFlushReminder(session.messages as BrainMessage[])) {
    const estimatedTokens = estimateContextSize(session.messages as Array<{ content: string }>);
    const flushThreshold = MAX_CONTEXT_TOKENS * PRE_COMPACTION_FLUSH_THRESHOLD;
    if (estimatedTokens >= flushThreshold) {
      session.messages.push({ role: 'system', content: MEMORY_FLUSH_MESSAGE });
      log.info(
        { sessionId: state.sessionId, estimatedTokens, flushThreshold },
        'LAYER 0: Pre-compaction memory flush reminder injected',
      );
    }
  }

  // TIER 1 — Two-tier compaction (gap #14, opt-in SUDO_TWO_TIER_COMPACT=1):
  // zero-cost, role-aware microcompact runs BEFORE the LLM-based LAYER 1 so
  // we skip the paid round-trip when shrinking middle tool outputs is enough
  // to fall back below shouldCompact's threshold. Default OFF, fail-open.
  // LAYER 1's existing shouldCompact() check re-runs against the trimmed
  // history, so a sufficient TIER 1 pass naturally suppresses LAYER 1.
  if (
    process.env['SUDO_TWO_TIER_COMPACT'] === '1' &&
    shouldCompact(session.messages as Array<{ content: string }>)
  ) {
    try {
      const result = microCompactMessages(
        session.messages as MicroCompactMessage[],
      );
      if (result.charsAfter < result.charsBefore) {
        session.messages = result.messages as typeof session.messages;
        log.info(
          {
            sessionId: state.sessionId,
            charsBefore: result.charsBefore,
            charsAfter: result.charsAfter,
            recoveredChars: result.charsBefore - result.charsAfter,
            clamped: result.clamped,
          },
          'TIER 1: zero-cost microcompact applied (gap #14)',
        );
      }
    } catch (err) {
      log.warn(
        { sessionId: state.sessionId, err: String(err) },
        'TIER 1 microcompact threw — falling through to LAYER 1',
      );
    }
  }

  // LAYER 1 — PROACTIVE compaction: summarise BEFORE hitting the limit (at 50% capacity)
  // This prevents the model from ever seeing a truncated context.
  if (shouldCompact(session.messages as Array<{ content: string }>)) {
    log.info({ sessionId: state.sessionId }, 'LAYER 1: Proactive compaction triggered');
    await runCompaction(brain, session, state, emit, hooks);
  }

  // TIER 2 / TIER 3 — compaction escalation (gap #14 deferred). Opt-in
  // SUDO_COMPACT_ESCALATE=1. Default OFF, fail-open. Only fires when LAYER 1's
  // summary (or LAYER 1 itself being off) leaves the history above
  // shouldCompact's threshold — wiring the latent autoCompact/fullCompact paths
  // so heavy sessions escalate instead of relying on LAYER 2/3 to clip alone.
  if (process.env['SUDO_COMPACT_ESCALATE'] === '1') {
    await escalateCompaction(brain, session, state);
  }

  // LAYER 2 — SNIP: micro-compact the in-memory history (zero API cost, pure JS)
  // Keeps head (first 2) and tail (last 8), trims middle to 200 chars each.
  const MAX_SNIP_CHARS = 200_000;
  const totalChars = session.messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  if (totalChars > MAX_SNIP_CHARS && session.messages.length > 10) {
    log.info({ sessionId: state.sessionId, totalChars }, 'LAYER 2: Snip compaction applied');
    const snipped = microCompact(
      session.messages.map(m => m.content ?? ''),
      MAX_SNIP_CHARS,
    );
    // Re-attach roles after micro-compact
    session.messages = session.messages.map((m, i) => ({
      ...m,
      content: snipped[i] ?? m.content,
    }));
  }

  // LAYER 3 — SLIDING WINDOW: keep system messages + last 12 non-system messages
  const WINDOW_SIZE = 12;
  const systemMsgs = session.messages.filter(m => m.role === 'system');
  const nonSystemMsgs = session.messages.filter(m => m.role !== 'system');
  let windowedNonSystem = nonSystemMsgs.slice(-WINDOW_SIZE);
  // Never start the window on an orphaned tool result: a role:'tool' message's
  // declaring assistant (with toolCalls) is the message immediately before it.
  // If the slice boundary fell inside a tool-call group, the leading tool-result
  // messages have no matching assistant tool_call, and the Vercel AI SDK's
  // convertToLanguageModelPrompt throws AI_MissingToolResultsError on the next
  // brain.call(). Advance the start past any leading orphan tool results.
  let firstNonOrphan = 0;
  while (firstNonOrphan < windowedNonSystem.length && windowedNonSystem[firstNonOrphan]!.role === 'tool') {
    firstNonOrphan++;
  }
  if (firstNonOrphan > 0) {
    windowedNonSystem = windowedNonSystem.slice(firstNonOrphan);
  }
  const windowed: BrainMessage[] = [
    ...systemMsgs.slice(0, 2),
    ...windowedNonSystem,
  ];

  if (nonSystemMsgs.length > WINDOW_SIZE) {
    log.info(
      {
        sessionId: state.sessionId,
        totalMessages: session.messages.length,
        windowedMessages: windowed.length,
        droppedMessages: nonSystemMsgs.length - windowedNonSystem.length,
      },
      'LAYER 3: Sliding window applied',
    );
  }

  // LAYER 4 — CONTEXT COLLAPSE: intelligently compress verbose tool results
  // Instead of dumb truncation, identify high-noise patterns and summarise them.
  return collapseToolResults(windowed) as BrainMessage[];
}

// ---------------------------------------------------------------------------
// Proactive session message trimming
// ---------------------------------------------------------------------------

/** Maximum messages in session before proactive trimming. */
export const SESSION_MESSAGE_TRIM_THRESHOLD = 40 as const;
/** Number of non-system messages to keep after trimming. */
export const SESSION_MESSAGE_KEEP_COUNT = 20 as const;

/**
 * Proactively trim session.messages to prevent unbounded growth.
 *
 * Keeps all system messages + the last N non-system messages.
 * Called at the start of each agent loop iteration.
 *
 * @param session - Mutable session object.
 * @param state   - Current agent state (for logging).
 */
export function trimSessionMessages(
  session: SessionLike,
  state: AgentState,
): void {
  const messages = session.messages;
  if (!Array.isArray(messages) || messages.length <= SESSION_MESSAGE_TRIM_THRESHOLD) {
    return;
  }

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  const keptNonSystem = nonSystemMsgs.slice(-SESSION_MESSAGE_KEEP_COUNT);

  session.messages = [...systemMsgs, ...keptNonSystem];

  log.info(
    {
      sessionId: state.sessionId,
      totalMessages: messages.length,
      keptMessages: session.messages.length,
      droppedMessages: messages.length - session.messages.length,
    },
    'Proactive session message trim applied',
  );
}

// ---------------------------------------------------------------------------
// GoalPlanner semantic per-run cap (Theme 2 follow-up)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-run cap on GoalPlanner semantic (brain.chat) planning calls
 * from the raw SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN value.
 *
 * Accepts ONLY a clean base-10 non-negative integer (surrounding whitespace is
 * trimmed). Anything else — unset, blank, signed ("+5"/"-1"), fractional ("2.9"),
 * hex ("0x10"), or other junk ("3x") — is treated as `undefined` (= no cap, the
 * pre-existing behavior). This is fail-open: a malformed value never changes
 * behavior and never crashes the turn. Strict parsing (rather than a lenient
 * `parseInt`) avoids the footgun where "0x10" would silently collapse to 0 and
 * thereby DISABLE semantic planning. A literal `0` is a valid cap meaning "no
 * semantic planning this run" (template only).
 *
 * @param raw - The raw env value (typically `process.env[...]`).
 * @returns The cap as a non-negative integer, or `undefined` for no cap.
 */
export function resolveSemanticPlanCap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether a semantic plan is allowed given the resolved cap and the number of
 * semantic calls already made this run. An `undefined` cap means no limit.
 *
 * @param cap         - Resolved cap from {@link resolveSemanticPlanCap}.
 * @param usedThisRun - Count of semantic plans already run this turn.
 */
export function semanticPlanAllowed(cap: number | undefined, usedThisRun: number): boolean {
  return cap === undefined || usedThisRun < cap;
}
