/**
 * @file brain-bridge.ts
 * @description gw-cutover Phase 2 — the Brain↔IR-transport seam, kept OUT of
 * brain.ts so the brain diff stays minimal. When `LLM_IR_CALLERS` matches the
 * request source, Brain's PER-ATTEMPT wire call goes through callIR/streamIR
 * instead of the ai-SDK. Brain's failover profile loop, cooldowns, billing
 * recorder, and all post-processing stay UNCHANGED — this module only swaps
 * the wire hop and maps the IRResponse back into the legacy result shape
 * (the exact INVERSE of shadow.ts resultToIR).
 *
 * Retry ownership: Brain's failover loop already owns retry (10 attempts
 * across profiles). Layering policy's 3 retries underneath would multiply, so
 * every call from here passes `noRetry: true` (CallIROptions → runWithPolicy
 * maxAttempts 1). Breaker/lanes/budgets still apply — only retry is disabled.
 *
 * Refusal semantics during ramp: callIR RETURNS provider lies (200-garbage /
 * content-filter refusals) as stop_reason 'error' rather than throwing.
 * `callTransportForBrain` converts those into a THROW so brain's seam falls
 * through to the legacy ai-SDK path for the same attempt — users never see an
 * IR-only artifact during the ramp; legacy owns whatever it does today.
 *
 * Thinking blocks: surfaced as `reasoningText` (joined), mirroring where the
 * ai-SDK v6 exposes provider reasoning — brain's reasoning-extraction path
 * (`_callSingleModel` empty-text fallback) reads exactly that field.
 * `reasoning` (the structured array) is left undefined; legacy brain only
 * falls back to it when reasoningText is absent.
 *
 * Cached-token telemetry: brain derives cache counts from ai-SDK
 * providerMetadata (extractPromptCacheTokens). The IR usage carries cached_in
 * directly, so the mapper synthesizes the minimal Anthropic-shaped metadata
 * object that extractor understands — brain's cache telemetry and cost
 * discounting keep working without touching brain code.
 */

import { randomUUID } from 'node:crypto';
import type { IRRequest, IRResponse, IRUsage } from '../../shared-types/ir/v1.js';
import type { IRStreamEvent } from './adapters/stream.js';
import { brainRequestToIR, type ShadowBrainRequest } from './shadow.js';
import { callIR, streamIR, type CallIROptions } from './transport.js';
import { LLMPolicyError } from './errors.js';

// ---------------------------------------------------------------------------
// Ramp flag
// ---------------------------------------------------------------------------

/**
 * True when `LLM_IR_CALLERS` covers `source`. Unset/empty → false (byte-
 * identical legacy behavior); `*` → all callers; otherwise a comma list of
 * exact source tags ('chat', 'agent', 'consciousness', …).
 */
export function irCallersEnabled(source: string): boolean {
  const raw = process.env['LLM_IR_CALLERS'];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .includes(source);
}

/** Short error-class tag for the `ir_transport_fallback` warn log. */
export function irErrorClass(err: unknown): string {
  if (err instanceof LLMPolicyError) return err.class;
  if (err instanceof Error) return err.constructor.name;
  return typeof err;
}

// ---------------------------------------------------------------------------
// IRResponse → legacy result shape (inverse of shadow.ts resultToIR)
// ---------------------------------------------------------------------------

/** ai-SDK v6 usage naming, as buildTokenUsage/_callSingleModel consume it. */
export interface BrainLegacyUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
}

/**
 * ai-SDK v6 tool-call shape as brain's extractToolCalls reads it:
 * `toolCallId` / `toolName` / `input` (parsed argument OBJECT — the IR layer
 * has already normalized string args through parseToolArguments).
 */
export interface BrainLegacyToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The legacy completion surface `_callSingleModel` post-processing reads. */
export interface BrainLegacyResult {
  text: string;
  finishReason: 'stop' | 'tool-calls' | 'length' | 'error';
  usage: BrainLegacyUsage;
  toolCalls: BrainLegacyToolCall[];
  reasoning: unknown;
  reasoningText: string | undefined;
  providerMetadata: unknown;
}

/** IR stop_reason → legacy finishReason (inverse of legacyFinishReasonToIR). */
export function irStopReasonToFinishReason(
  stop: IRResponse['stop_reason'],
): BrainLegacyResult['finishReason'] {
  switch (stop) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool-calls';
    case 'max_tokens':
      return 'length';
    case 'error':
    default:
      return 'error';
  }
}

function irUsageToLegacy(u: IRUsage): BrainLegacyUsage {
  return {
    inputTokens: u.in,
    outputTokens: u.out,
    totalTokens: u.in + u.out,
    cachedInputTokens: u.cached_in,
  };
}

/**
 * Map an IRResponse into the legacy ai-SDK-shaped result brain post-processing
 * consumes. Pure — never throws, never inspects env.
 */
export function irResponseToBrainResult(ir: IRResponse, _modelId: string): BrainLegacyResult {
  let text = '';
  let thinking = '';
  const toolCalls: BrainLegacyToolCall[] = [];
  for (const b of ir.blocks) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'thinking') thinking += b.thinking;
    else if (b.type === 'tool_use') {
      toolCalls.push({ toolCallId: b.id, toolName: b.name, input: b.input });
    }
  }
  // Synthesized Anthropic-shaped metadata so extractPromptCacheTokens (the
  // only providerMetadata reader on this path) sees the cache-read count the
  // IR usage already carries. cached_in is 0 on non-Anthropic routes.
  const providerMetadata =
    ir.usage.cached_in > 0
      ? { anthropic: { usage: { cache_read_input_tokens: ir.usage.cached_in, cache_creation_input_tokens: 0 } } }
      : undefined;
  return {
    text,
    finishReason: irStopReasonToFinishReason(ir.stop_reason),
    usage: irUsageToLegacy(ir.usage),
    toolCalls,
    reasoning: undefined,
    reasoningText: thinking !== '' ? thinking : undefined,
    providerMetadata,
  };
}

// ---------------------------------------------------------------------------
// Non-streaming: one brain attempt through the IR transport
// ---------------------------------------------------------------------------

function toBrainIR(request: ShadowBrainRequest, modelId: string, purpose: string): IRRequest {
  // brainRequestToIR already sets caller = source ?? 'chat' and priority via
  // the same rule as brain's _gatewayPriorityFor (chat/agent → user).
  const ir = brainRequestToIR(request, modelId);
  ir.purpose = purpose;
  ir.trace_id = randomUUID();
  return ir;
}

export interface BrainTransportCall {
  result: BrainLegacyResult;
  /** The llm_calls trace_id the transport logged (for noteTraceForSession). */
  traceId: string;
}

/**
 * One non-streaming brain attempt via callIR, policy retry DISABLED (brain's
 * failover loop owns retry). Throws on any transport failure — including
 * stop_reason 'error' responses (provider refusal/garbage), which the brain
 * seam converts into a same-attempt legacy fallback during the ramp.
 */
export async function callTransportForBrain(
  request: ShadowBrainRequest,
  modelId: string,
  opts: CallIROptions = {},
): Promise<BrainTransportCall> {
  const ir = toBrainIR(request, modelId, 'brain.call');
  const res = await callIR(ir, { ...opts, noRetry: true });
  if (res.stop_reason === 'error') {
    throw new LLMPolicyError(
      `[brain-bridge] IR response stop_reason 'error' for ${modelId} — deferring to legacy path`,
      { class: 'provider_bug', retryable: false },
    );
  }
  return { result: irResponseToBrainResult(res, modelId), traceId: ir.trace_id };
}

// ---------------------------------------------------------------------------
// Streaming: facade mirroring the minimal streamText surface brain reads
// ---------------------------------------------------------------------------

/**
 * The ONLY fields Brain.stream() touches on a streamText result are
 * `textStream` (async-iterated for text chunks) and `usage` (awaited after the
 * stream; providerMetadata is awaited defensively but tolerated absent).
 * `finishReason` is exposed for parity with the lazily-resolved promise shape.
 * Both promises ALWAYS resolve (never reject) — settled in the generator's
 * finally so an abandoned stream can't leak an unhandled rejection.
 */
export interface BrainStreamFacade {
  textStream: AsyncIterable<string>;
  usage: Promise<BrainLegacyUsage | undefined>;
  finishReason: Promise<BrainLegacyResult['finishReason'] | undefined>;
  /** The llm_calls trace_id the transport logged (for noteTraceForSession). */
  traceId: string;
}

/**
 * One streaming brain attempt via streamIR, policy retry DISABLED.
 *
 * Fallback contract (mirrors the spec's Rule 4 split):
 * - BEFORE the first text delta: any throw, or a terminal stop_reason 'error'
 *   with no text — this function REJECTS, and the brain seam falls through to
 *   the legacy streaming path (user never sees a difference).
 * - AFTER the first text delta: the facade is committed. A terminal
 *   stop_reason 'error' surfaces as a THROW from `textStream` (the machine's
 *   terminal error) — the transport never re-requests; brain's existing
 *   post-error handling owns it, exactly as a legacy mid-stream streamText
 *   error would.
 */
export async function streamTransportForBrain(
  request: ShadowBrainRequest,
  modelId: string,
  opts: CallIROptions = {},
): Promise<BrainStreamFacade> {
  const ir = toBrainIR(request, modelId, 'brain.stream');
  const gen = streamIR(ir, { ...opts, noRetry: true });

  // Holder object (not bare lets) so TS control-flow narrowing can't wrongly
  // pin `terminal` to null across the closure mutations below.
  const st = {
    terminal: null as { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null,
    streamError: undefined as string | undefined,
  };

  let resolveUsage!: (u: BrainLegacyUsage | undefined) => void;
  let resolveFinish!: (f: BrainLegacyResult['finishReason'] | undefined) => void;
  const usage = new Promise<BrainLegacyUsage | undefined>((r) => (resolveUsage = r));
  const finishReason = new Promise<BrainLegacyResult['finishReason'] | undefined>(
    (r) => (resolveFinish = r),
  );

  const handle = (ev: IRStreamEvent): string | null => {
    if (ev.type === 'text_delta') return ev.text;
    if (ev.type === 'stream_error') st.streamError = ev.error;
    if (ev.type === 'message_end') st.terminal = { stop_reason: ev.stop_reason, usage: ev.usage };
    return null;
  };

  // Pre-first-token window: pull until the first text delta or the terminal
  // event. Throws (HTTP errors, policy skips) propagate to the caller →
  // legacy fallback. An error-terminal with no text also rejects here.
  const buffered: string[] = [];
  try {
    while (st.terminal === null && buffered.length === 0) {
      const { done, value } = await gen.next();
      if (done) break;
      const t = handle(value);
      if (t !== null) buffered.push(t);
    }
    if (buffered.length === 0 && st.terminal !== null && st.terminal.stop_reason === 'error') {
      throw new LLMPolicyError(
        `[brain-bridge] IR stream terminated with error before first token: ${st.streamError ?? 'unknown'}`,
        { class: 'provider_bug', retryable: false },
      );
    }
  } catch (err) {
    // Settle the promises so nothing downstream can hang on them, then reject.
    resolveUsage(undefined);
    resolveFinish(undefined);
    await gen.return(undefined).catch(() => {
      /* transport finally owns cleanup */
    });
    throw err;
  }

  async function* textStream(): AsyncGenerator<string, void, undefined> {
    try {
      for (const t of buffered) yield t;
      if (st.terminal === null) {
        for await (const ev of gen) {
          const t = handle(ev);
          if (t !== null) yield t;
        }
      }
      if (st.terminal !== null && st.terminal.stop_reason === 'error') {
        // Post-first-token terminal error — surface the machine's terminal
        // error; the transport already refused to re-request (Rule 4).
        throw new Error(st.streamError ?? 'IR stream terminated with stop_reason error');
      }
    } finally {
      resolveUsage(st.terminal !== null ? irUsageToLegacy(st.terminal.usage) : undefined);
      resolveFinish(
        st.terminal !== null ? irStopReasonToFinishReason(st.terminal.stop_reason) : undefined,
      );
    }
  }

  return { textStream: textStream(), usage, finishReason, traceId: ir.trace_id };
}
