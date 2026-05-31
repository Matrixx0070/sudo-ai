/**
 * Internal helpers for AgentLoop.
 *
 * Extracted to keep loop.ts under 300 lines.
 * Not part of the public barrel export — only imported by loop.ts.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError, ToolError } from '../shared/errors.js';
import { compact, microCompact } from './compaction.js';
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
}

export interface ToolRegistryLike {
  execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<{ success: boolean; output: string }>;
  getSchemaForLLM(): object[];
  /** Return whether a tool requires user confirmation before execution. */
  requiresConfirmation?(name: string): boolean;
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
 * The real SandboxManager must implement at minimum these two methods.
 */
export interface SandboxManagerLike {
  /** Return the provisioned workspace directory for the given sessionId. */
  getWorkspaceDir(sessionId: string): string;
  /** Return the merged sandbox policy for the given sessionId. */
  getPolicyFor(sessionId: string): import('../sandbox/sandbox-types.js').SandboxPolicy;
}

// ---------------------------------------------------------------------------
// Parallel tool-call execution helpers (Upgrade 5)
// ---------------------------------------------------------------------------

/** Tool name prefixes that mutate shared state and must always run sequentially. */
const SEQUENTIAL_TOOL_PREFIXES: readonly string[] = [
  'file.write', 'file.delete', 'file.move', 'file.rename',
  'shell.run', 'shell.exec', 'code.run', 'code.exec',
  'browser.navigate', 'browser.click', 'browser.type',
  'db.write', 'db.insert', 'db.update', 'db.delete',
  'memory.save', 'memory.delete',
];

/**
 * Return true when a tool call can run concurrently with others.
 * Sequential when it has a mutating prefix or shares a `path` arg with another call.
 */
function isParallelSafe(
  tc: { name: string; arguments: Record<string, unknown> },
  allCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>,
): boolean {
  const nameL = tc.name.toLowerCase();
  for (const prefix of SEQUENTIAL_TOOL_PREFIXES) {
    if (nameL.startsWith(prefix)) return false;
  }
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

function partitionToolCalls(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): PartitionResult {
  if (calls.length <= 1) {
    return { leadingSequential: calls, parallel: [], trailingSequential: [] };
  }
  const safeFlags = calls.map(tc => isParallelSafe(tc, calls));
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

  let resultContent: string;
  try {
    const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
      ? tc.arguments
      : {};
    const result = await toolRegistry.execute(tc.name, safeArgs, ctx);
    resultContent = typeof result.output === 'string' ? result.output : String(result.output ?? '');
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id });
    log.info({ tool: tc.name, success: result.success }, 'Tool call completed');
    // TODO: Wire FeedbackMemory.recordSuccess here in boot sequence
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
    // TODO: Wire FeedbackMemory.recordFailure here in boot sequence
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
): Promise<void> {
  const policyFromSandbox = sandboxManager?.getPolicyFor(state.sessionId);
  const workspaceDir = sandboxManager?.getWorkspaceDir(state.sessionId) ?? process.cwd();
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
  const { leadingSequential, parallel, trailingSequential } = partitionToolCalls(approvedCalls);

  // Phase 2a: leading sequential block.
  for (const tc of leadingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security);
    commit(res);
  }

  // Phase 2b: parallel batch (two or more safe tools).
  if (parallel.length > 1) {
    log.info(
      { count: parallel.length, tools: parallel.map(t => t.name) },
      'Running tool calls in parallel',
    );
    const results = await Promise.all(
      parallel.map(tc => executeSingleToolCall(tc, ctx, emit, toolRegistry, security)),
    );
    // Append in original order so the LLM context stays coherent.
    for (const res of results) commit(res);
  } else if (parallel.length === 1) {
    const res = await executeSingleToolCall(parallel[0]!, ctx, emit, toolRegistry, security);
    commit(res);
  }

  // Phase 2c: trailing sequential block.
  for (const tc of trailingSequential) {
    const res = await executeSingleToolCall(tc, ctx, emit, toolRegistry, security);
    commit(res);
  }

  state.pendingToolCalls = 0;
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
  // If a promptCacheManager is available (injected via Builder B's brain wiring),
  // check cache here before forwarding messages to brain.call(). The cache key
  // should be derived from the last user message + active tool set hash.
  // TODO: Wire PromptCacheManager.check(cacheKey) here once injected by boot sequence.

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
  const windowed: BrainMessage[] = [
    ...systemMsgs.slice(0, 2),
    ...nonSystemMsgs.slice(-WINDOW_SIZE),
  ];

  if (nonSystemMsgs.length > WINDOW_SIZE) {
    log.info(
      {
        sessionId: state.sessionId,
        totalMessages: session.messages.length,
        windowedMessages: windowed.length,
        droppedMessages: nonSystemMsgs.length - WINDOW_SIZE,
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
