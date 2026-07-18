/**
 * F103 loop-helpers decomposition — executeToolCalls batch orchestration:
 * approval gate, trust-tier exec isolation, sequential/parallel phases, and
 * the commit closure that lands annotated results in session history.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import { createLogger } from '../../shared/logger.js';
import { approvalManager } from '../approval.js';
import { PermissionManager } from '../permissions.js';
import type { AgentState } from '../types.js';
import { classifyTrustTier, isTierRoutingEnabled, resolveUntrustedNetwork, UNTRUSTED_EXEC_BACKEND } from '../../sandbox/trust-tier.js';
import type {
  ToolContext,
  Emitter,
  ToolRegistryLike,
  SecurityGuardLike,
  BrainLike,
  HookEmitterLike,
  SandboxManagerLike,
  FeedbackMemoryLike,
  VerifyGateLike,
  GroundingCheckerLike,
  CriticPassLike,
  SessionLike,
} from './types.js';
import {
  _safeEmit as safeEmit,
  _executeSingleToolCall as executeSingleToolCall,
  type _SingleCallResult as SingleCallResult,
  type PreventionLookupLike,
} from './tool-exec.js';
import { _partitionToolCalls, _getToolConcurrency as getToolConcurrency } from './tool-parallel.js';

const log = createLogger('agent:loop');

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
  // Caller identity (Feature 1 isOwner + channel/peer) is bound to AgentState at
  // run() start by the dispatch layer — turn-scoped, so ctx carries the RIGHT
  // caller with no shared-registry race. Undefined for internal/autonomous turns.
  const caller = state.caller;

  // TRUST-TIER EXEC ISOLATION (Feature 8): an untrusted turn (an explicit
  // non-owner caller — hook/email/community) is routed to the throwaway
  // container backend and MUST fail closed if that backend is unavailable, while
  // the owner's own turns keep the host backend. getPolicyFor returns a fresh
  // copy per call, so mutating it here is turn-scoped (no shared-default bleed).
  // Undefined caller = internal/autonomous turn → host-tier, untouched.
  if (
    policyFromSandbox &&
    isTierRoutingEnabled() &&
    classifyTrustTier(caller) === 'untrusted'
  ) {
    policyFromSandbox.execBackend = UNTRUSTED_EXEC_BACKEND;
    policyFromSandbox.requireIsolatedBackend = true;
    // Untrusted turns get no host network by default (defense in depth alongside
    // the container's own --network none). A caller-carried egress opt-in (set
    // by the channel boundary from operator config, e.g. a hook's `network:
    // 'allowlist'` in webhooks.json5) upgrades to the ENFORCED allowlist mode —
    // never to 'host', and still behind requireIsolatedBackend.
    const egress = resolveUntrustedNetwork(caller);
    policyFromSandbox.network = egress.network;
    if (egress.network === 'allowlist' && egress.hosts) {
      policyFromSandbox.allowedEgressHosts = egress.hosts;
    }
    log.info(
      {
        sessionId: state.sessionId,
        channel: caller?.channel,
        backend: UNTRUSTED_EXEC_BACKEND,
        network: egress.network,
      },
      'Trust-tier routing: untrusted turn → isolated container backend (fail-closed)',
    );
  }

  const ctx: ToolContext = {
    sessionId: state.sessionId,
    workingDir: workspaceDir,
    workspaceDir,
    sandboxPolicy: policyFromSandbox,
    config: brain ? { brain } : null,
    logger: log,
    ...(caller ? { isOwner: caller.isOwner, ...(caller.channel ? { channel: caller.channel } : {}), ...(caller.peerId ? { peerId: caller.peerId } : {}) } : {}),
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
    // Error hint goes at the BOTTOM (after the raw output) — closest to where the
    // model resumes, so the "how to fix" is the last thing it reads before retry.
    if (res.errorHint) stored = `${stored}\n\n${res.errorHint}`;
    // Browser recovery (fresh refs / escalation) goes at the very bottom — the
    // last thing the model reads before it retries the browser action.
    if (res.recoveryHint) stored = `${stored}\n\n${res.recoveryHint}`;
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
