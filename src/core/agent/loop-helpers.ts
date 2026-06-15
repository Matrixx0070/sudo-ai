/**
 * Internal helpers for AgentLoop.
 *
 * Extracted to keep loop.ts under 300 lines.
 * Not part of the public barrel export — only imported by loop.ts.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError, ToolError } from '../shared/errors.js';
import { compact, microCompact } from './compaction.js';
import { microCompactMessages, type MicroCompactMessage } from './microcompact.js';
import { shouldCompact, estimateContextSize, MAX_CONTEXT_TOKENS } from './context.js';
import { PRE_COMPACTION_FLUSH, PRE_COMPACTION_FLUSH_THRESHOLD } from '../shared/constants.js';
import { approvalManager } from './approval.js';
import { PermissionManager } from './permissions.js';
import type { AgentState, AgentEvent } from './types.js';
import { resolveEffort, type EffortLevel } from './effort.js';
import { shouldUseInterleavedThinking, buildThinkingBlock } from './interleaved-thinking.js';

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
  tools?: object[];
  race?: boolean;
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
  getSchemaForLLM(): object[];
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
}

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
): Promise<SingleCallResult> {
  emit({ type: 'tool-call', name: tc.name, args: tc.arguments, toolId: tc.id });
  log.info({ tool: tc.name, toolCallId: tc.id, sessionId: ctx.sessionId }, 'Executing tool call');

  if (security) {
    const secResult = security.validateToolCall(tc.name, tc.arguments ?? {});
    if (!secResult.allowed) {
      const blockedMsg = `[SecurityGuard] Tool call blocked: ${tc.name} — ${secResult.reason ?? 'policy violation'}`;
      log.warn({ tool: tc.name, reason: secResult.reason, sessionId: ctx.sessionId }, 'Tool call blocked by security');
      emit({ type: 'tool-result', name: tc.name, result: blockedMsg, toolId: tc.id });
      return { tc, resultContent: blockedMsg };
    }
  }

  const permMode = PermissionManager.getInstance().check(tc.name);
  if (permMode === 'deny') {
    const deniedMsg = `[PermissionManager] Tool execution permanently denied: ${tc.name}`;
    log.warn({ tool: tc.name, sessionId: ctx.sessionId }, deniedMsg);
    emit({ type: 'tool-result', name: tc.name, result: deniedMsg, toolId: tc.id });
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
            log.warn(
              { tool: tc.name, reason: grounding.reason, checked: grounding.checked, evidence: grounding.evidence, sessionId: ctx.sessionId, block: groundingBlockEnabled },
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
              blocked: groundingBlockEnabled,
              confidence: gate.confidence,
              threshold: gate.threshold,
            });
            if (groundingBlockEnabled) {
              const blockedMsg = `[VerifyGate] Tool call blocked: ${tc.name} — grounding mismatch (${grounding.reason})`;
              emit({ type: 'tool-result', name: tc.name, result: blockedMsg, toolId: tc.id });
              return { tc, resultContent: blockedMsg };
            }
          }
        }
      }
    } catch (err) {
      log.warn({ tool: tc.name, err: String(err) }, 'verify-gate: evaluate threw — failing open');
    }
  }

  let resultContent: string;
  try {
    const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
      ? tc.arguments
      : {};
    const result = await toolRegistry.execute(tc.name, safeArgs, ctx);
    resultContent = typeof result.output === 'string' ? result.output : String(result.output ?? '');
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id });
    log.info({ tool: tc.name, success: result.success }, 'Tool call completed');
    guardedRecordFeedback(feedbackMemory, true, tc.name, tc.arguments ?? {}, resultContent || 'success', ctx.sessionId);
  } catch (err) {
    if (err instanceof ToolError && err.code === 'tool_not_found') {
      log.warn({ tool: tc.name }, 'Tool not found — invoking fallback chain');
      const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
        ? tc.arguments
        : {};
      const fallbackResult = await _toolNotFoundFallback(tc.name, safeArgs, toolRegistry, ctx);
      emit({ type: 'tool-result', name: tc.name, result: fallbackResult, toolId: tc.id });
      return { tc, resultContent: fallbackResult };
    }
    resultContent = `Error executing tool ${tc.name}: ${String(err)}`;
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id });
    log.error({ tool: tc.name, err }, 'Tool call failed');
    guardedRecordFeedback(feedbackMemory, false, tc.name, tc.arguments ?? {}, resultContent || String(err), ctx.sessionId);
  }

  return { tc, resultContent };
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
      emit({ type: 'tool-result', name: tc.name, result: deniedMsg, toolId: tc.id });
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
        emit({ type: 'tool-result', name: tc.name, result: denied, toolId: tc.id });
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
    // toolCallId and toolName MUST be present for the Vercel AI SDK to
    // correctly match tool results back to tool calls on the next LLM turn.
    session.messages.push({
      role: 'tool',
      content: res.resultContent,
      toolCallId: res.tc.id,
      toolName: res.tc.name,
    });
    state.pendingToolCalls--;
    // Fire-and-forget: tool_result_persist signals that the result is now in session history.
    void safeEmit(hooks, 'tool_result_persist', {
      sessionId: state.sessionId,
      toolName: res.tc.name,
      result: res.resultContent,
    });
  };

  // Phase 1: partition into sequential / parallel groups.
  const { leadingSequential, parallel, trailingSequential } = _partitionToolCalls(approvedCalls, toolRegistry);

  // Phase 2a: leading sequential block.
  for (const tc of leadingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled);
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
        chunk.map(tc => executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled)),
      );
      // Append in original order so the LLM context stays coherent.
      for (const res of results) commit(res);
    }
  } else if (parallel.length === 1) {
    const res = await executeSingleToolCall(parallel[0]!, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled);
    commit(res);
  }

  // Phase 2c: trailing sequential block.
  for (const tc of trailingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security, feedbackMemory, verifyGate, hooks, groundingChecker, groundingBlockEnabled);
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
