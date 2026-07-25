/**
 * Loop-step context (AL1.2) — ambient turn/step correlation for telemetry.
 *
 * Lives apart from logging.ts so agent code can establish the context without
 * importing the SQLite-backed gateway log module (layering: the loop knows
 * about turns/steps; only the log knows about tables).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Identifies the loop iteration an LLM/tool call is serving. */
export interface LoopStepContext {
  sessionId: string;
  turnId: string;
  stepN: number;
  tool?: string;
}

/**
 * One tool execution, as handed to logging.ts recordToolCall. Tool executions
 * get their own `tool_calls` table (same DB, same module — NOT a second log
 * path): they are loop steps, not LLM calls, and stuffing them into
 * `llm_calls` would corrupt that table's per-call cost/token semantics.
 */
export interface ToolCallRecord {
  sessionId: string;
  tool: string;
  latencyMs: number;
  /** 'success' | 'error' | 'denied' — free text, mirrors llm_calls.outcome. */
  outcome: string;
  /** Ambient-filled from the loop-step context when omitted. */
  turnId?: string;
  stepN?: number;
  ts?: string;
}

/**
 * AsyncLocalStorage rather than a module global so concurrent sessions (and
 * background callers like cognitive-stream firing mid-iteration on their own
 * async paths) can never be stamped with another turn's context.
 */
const _loopStepStorage = new AsyncLocalStorage<LoopStepContext>();

/**
 * Run `fn` with an ambient loop-step context; every GatewayCallLog.record and
 * recordToolCall inside it inherits {sessionId, turnId, stepN}.
 */
export function runWithLoopStep<T>(ctx: LoopStepContext, fn: () => T): T {
  return _loopStepStorage.run(ctx, fn);
}

/** The ambient loop-step context, or undefined outside a wrapped scope. */
export function currentLoopStep(): LoopStepContext | undefined {
  return _loopStepStorage.getStore();
}
