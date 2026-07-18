/**
 * F103 loop-helpers decomposition — single tool-call execution:
 * verify-gate slices (critic, grounding), feedback recording, error/prevention/
 * recovery hints, and the tool_not_found fallback chain.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import { createLogger } from '../../shared/logger.js';
import {
  computeBrowserRecovery,
  isBrowserActionTool,
  isBrowserRecoveryEnabled,
  resetBrowserRecovery,
} from '../browser-recovery.js';
import { isOutboundToolName, markCommittedOutbound } from '../committed-outbound.js';
import { ToolError } from '../../shared/errors.js';
// gw-refactor Phase 5: fail-open outcome stamp onto the session's last gateway trace.
import { markOutcomeForSession } from '../../../llm/logging.js';
import { PermissionManager } from '../permissions.js';
import { clampToolOutput } from '../tool-output-clamp.js';
import { enrichToolError, isToolErrorHintsEnabled } from '../../tools/error-formatter.js';
import {
  readCriticFeedbackEnabled,
  renderCriticFeedback,
  readCriticBlockEnabled,
  renderCriticBlockMessage,
} from '../verify-gate-critic.js';
import { isGroundingBlockEnabled } from '../verify-gate-grounding.js';
import type {
  ToolContext,
  Emitter,
  ToolRegistryLike,
  SecurityGuardLike,
  FeedbackMemoryLike,
  VerifyGateLike,
  HookEmitterLike,
  GroundingCheckerLike,
  CriticPassLike,
} from './types.js';

const log = createLogger('agent:loop');

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
    // Distinct from baseCtx.confidence (the slice-1 gate confidence): this is
    // the critic's own 0-100 certainty in its verdict. Null when the model
    // omitted it. Observable-only — does not gate execution.
    criticConfidence: result.confidence ?? null,
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
  /**
   * Structured tool-error hint (what/why/fix/example) appended to the
   * model-facing tool message on failure so a weaker model can self-correct.
   * Carried separately from `resultContent` so the recorded outcome / trace
   * stays the raw output. Undefined on success or when hints are disabled.
   */
  errorHint?: string;
  /**
   * Browser live-loop recovery: on a FAILED browser ACTION, a fresh stable-ref
   * snapshot to retry with (or, after repeated failures, an escalation/stop
   * directive). Appended to the model-facing message like errorHint; the raw
   * outcome/trace stay untouched. Undefined for non-browser tools / on success /
   * when SUDO_BROWSER_RECOVERY=0.
   */
  recoveryHint?: string;
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
            markOutcomeForSession(ctx.sessionId, 'verifier_rejected'); // Phase 5 (fail-open, SUDO_GATEWAY_LOG=0 off)
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
              criticConfidence: criticResult.confidence ?? null,
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
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id, success: result.success, args: tc.arguments ?? {} });
    log.info({ tool: tc.name, success: result.success }, 'Tool call completed');
    guardedRecordFeedback(feedbackMemory, true, tc.name, tc.arguments ?? {}, resultContent || 'success', ctx.sessionId);
    // A tool can report failure via its authoritative `success` flag without throwing.
    if (!result.success) callError = resultContent;
    else {
      // A successful browser action clears the recovery failure streak.
      if (isBrowserActionTool(tc.name)) resetBrowserRecovery(ctx.sessionId);
      // Run-level outbound evidence: a successful send/post/spawn/cron makes this
      // turn unsafe to blindly re-run (a retry would re-fire the side effect).
      if (isOutboundToolName(tc.name)) markCommittedOutbound(ctx.sessionId);
    }
  } catch (err) {
    if (err instanceof ToolError && err.code === 'tool_not_found') {
      log.warn({ tool: tc.name }, 'Tool not found — invoking fallback chain');
      const safeArgs = (tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments))
        ? tc.arguments
        : {};
      const fallbackResult = clampToolOutput(await _toolNotFoundFallback(tc.name, safeArgs, toolRegistry, ctx));
      emit({ type: 'tool-result', name: tc.name, result: fallbackResult, toolId: tc.id, args: tc.arguments ?? {} });
      // Slice-4: even on tool_not_found the critic verdict (if any) was
      // about the *call the agent planned*, so it's still informative for
      // the next-turn replanning. Surface it.
      return { tc, resultContent: fallbackResult, ...(criticFeedback ? { criticFeedback } : {}) };
    }
    resultContent = `Error executing tool ${tc.name}: ${String(err)}`;
    emit({ type: 'tool-result', name: tc.name, result: resultContent, toolId: tc.id, success: false, args: tc.arguments ?? {} });
    log.error({ tool: tc.name, err }, 'Tool call failed');
    guardedRecordFeedback(feedbackMemory, false, tc.name, tc.arguments ?? {}, resultContent || String(err), ctx.sessionId);
    callError = resultContent;
  }

  // Idiot-proof error hints: on any failure, compute structured recovery
  // guidance (what/why/fix/example) so a weaker model can self-correct instead
  // of retrying the same broken call. Carried as a SEPARATE field (like
  // preventionHint) so the recorded outcome and trace stay the raw output —
  // the caller appends this to the model-facing message only, at the bottom
  // where a model attends most before retrying. Fail-open. Kill-switch:
  // SUDO_TOOL_ERROR_HINTS=0.
  let errorHint: string | undefined;
  if (callError && isToolErrorHintsEnabled()) {
    try {
      errorHint = enrichToolError(tc.name, callError);
    } catch (err) {
      log.warn({ tool: tc.name, err: String(err) }, 'error-hint enrichment threw — skipping');
    }
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

  // Browser live-loop recovery: on a failed browser ACTION, augment the model
  // message with fresh stable refs to retry with — or, after repeated failures,
  // escalate to the operator and tell the model to stop. Fail-open.
  let recoveryHint: string | undefined;
  if (callError && isBrowserActionTool(tc.name) && isBrowserRecoveryEnabled()) {
    try {
      const rec = await computeBrowserRecovery({
        toolName: tc.name,
        args: tc.arguments ?? {},
        sessionId: ctx.sessionId,
      });
      if (rec.hint) recoveryHint = rec.hint;
    } catch (err) {
      log.warn({ tool: tc.name, err: String(err) }, 'browser recovery threw — skipping hint');
    }
  }

  return {
    tc,
    resultContent,
    ...(criticFeedback ? { criticFeedback } : {}),
    ...(preventionHint ? { preventionHint } : {}),
    ...(errorHint ? { errorHint } : {}),
    ...(recoveryHint ? { recoveryHint } : {}),
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

// F103: shared with sibling loop-helpers/ modules — internal, do not import
// from outside the loop-helpers/ directory.
export { safeEmit as _safeEmit, executeSingleToolCall as _executeSingleToolCall };
export type { SingleCallResult as _SingleCallResult };
