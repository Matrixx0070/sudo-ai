/**
 * @file brain-bridge.ts
 * @description The Brain↔IR-transport seam, kept OUT of brain.ts so the brain
 * diff stays minimal. Every Brain PER-ATTEMPT wire call goes through
 * callIR/streamIR (F97: the LLM_IR_CALLERS ramp and the legacy ai-SDK path
 * are retired — this is the only wire path). Brain's failover profile loop,
 * cooldowns, billing recorder, and all post-processing are UNCHANGED — this
 * module only performs the wire hop and maps the IRResponse back into the
 * result shape brain's post-processing consumes (the exact INVERSE of
 * shadow.ts resultToIR).
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
// IRResponse → legacy result shape (inverse of shadow.ts resultToIR)
// ---------------------------------------------------------------------------

/** ai-SDK v6 usage naming, as buildTokenUsage/_callSingleModel consume it. */
export interface BrainLegacyUsage {
  /** TOTAL input incl. cached (IRUsage invariant — ai-SDK/OpenAI semantics). */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cache-READ subset of inputTokens (Anthropic cache_read_input_tokens). */
  cachedInputTokens: number;
  /** Cache-CREATION subset of inputTokens (Anthropic only; 0 elsewhere). */
  cacheCreationInputTokens: number;
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
    cacheCreationInputTokens: u.cache_creation_in ?? 0,
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
  // only providerMetadata reader on this path) sees the cache-read AND
  // cache-creation counts the IR usage already carries. Both are 0 on
  // non-Anthropic routes.
  const cacheCreation = ir.usage.cache_creation_in ?? 0;
  const providerMetadata =
    ir.usage.cached_in > 0 || cacheCreation > 0
      ? { anthropic: { usage: { cache_read_input_tokens: ir.usage.cached_in, cache_creation_input_tokens: cacheCreation } } }
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
 * stop_reason 'error' responses (provider refusal/garbage) — so brain's
 * failover catch classifies + cooldowns the profile and advances (F97: there
 * is no legacy fallback; the throw IS the failover signal).
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
      `[brain-bridge] IR response stop_reason 'error' for ${modelId} — failing the attempt over`,
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
  /**
   * Resolves with the terminal usage on completion, or the transport's
   * LAST-KNOWN partial usage when the consumer breaks/abandons textStream
   * (never undefined once the facade was returned) — brain bills cancelled
   * IR streams from this, exactly like the legacy cancelled-stream path.
   */
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

  // Holder object (not bare lets) so TS control-flow narrowing can't wrongly
  // pin `terminal` to null across the closure mutations below. `lastUsage`
  // is the transport's last-known partial-usage snapshot (settled from
  // streamIR's finally) — a consumer-cancelled stream bills THAT, never
  // undefined, mirroring legacy brain's cancelled-stream billing.
  const st = {
    terminal: null as { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null,
    streamError: undefined as string | undefined,
    lastUsage: { in: 0, out: 0, cached_in: 0 } as IRUsage,
  };
  const gen = streamIR(ir, {
    ...opts,
    noRetry: true,
    onPartialUsage: (u) => {
      st.lastUsage = u;
    },
  });

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
      // Consumer break/abandonment: close the transport generator FIRST so its
      // finally runs (fetch abort + partial llm_calls row + onPartialUsage
      // callback) before we settle. Cheap no-op when the stream already
      // finished. NEVER throws (generator return does not re-raise).
      await gen.return(undefined).catch(() => {
        /* transport finally owns cleanup */
      });
      // Settle usage from the terminal when the stream completed, else from
      // the transport's last-known partial snapshot — never undefined once
      // the facade was handed out, so cancelled streams still get billed.
      resolveUsage(irUsageToLegacy(st.terminal !== null ? st.terminal.usage : st.lastUsage));
      resolveFinish(
        st.terminal !== null ? irStopReasonToFinishReason(st.terminal.stop_reason) : undefined,
      );
    }
  }

  return { textStream: textStream(), usage, finishReason, traceId: ir.trace_id };
}
