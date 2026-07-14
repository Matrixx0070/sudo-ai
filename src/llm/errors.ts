/**
 * @file errors.ts
 * @description LLM error taxonomy for the src/llm layer (gw-refactor Phase 4).
 *
 * One closed set of error classes every transport/adapter failure collapses
 * into, built ON TOP of the existing failover machinery in
 * src/core/shared/errors.ts — categorizeError and its body-sniffers are
 * imported and reused, never re-implemented, so a body pattern fixed there
 * (e.g. a new billing phrasing) is fixed here for free.
 *
 * Three entry points:
 * - classifyHttpError(status, body)      — non-2xx HTTP responses.
 * - classifyOpenAIResponse / classifyAnthropicResponse — the "provider lies"
 *   case: HTTP 200 whose parsed IRResponse is garbage or a refusal.
 * - classifyThrown(err)                  — thrown values (network, abort, …).
 */

import type { IRResponse } from '../../shared-types/ir/v1.js';
import {
  categorizeError,
  LLMError,
  type ErrorCategory,
} from '../core/shared/errors.js';

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export type LLMErrorClass =
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'context_exceeded'
  | 'billing'
  | 'auth'
  | 'content_filter'
  | 'invalid_request'
  | 'provider_bug'
  | 'network'
  | 'unknown';

/** ErrorCategory (failover layer) → LLMErrorClass (src/llm layer). */
const CATEGORY_TO_CLASS: Record<ErrorCategory, LLMErrorClass> = {
  rate_limit: 'rate_limited',
  overloaded: 'overloaded',
  timeout: 'timeout',
  context_overflow: 'context_exceeded',
  billing: 'billing',
  auth: 'auth',
  auth_permanent: 'auth',
  model_not_found: 'invalid_request',
  format: 'invalid_request',
  session_expired: 'invalid_request',
};

/** Only these classes are ever worth an automatic retry. */
export function isRetryable(cls: LLMErrorClass): boolean {
  return cls === 'rate_limited' || cls === 'overloaded' || cls === 'timeout' || cls === 'network';
}

// ---------------------------------------------------------------------------
// Content-filter body sniffing
// ---------------------------------------------------------------------------

/**
 * Whether an HTTP error body reports a content-policy refusal (moderation
 * block) rather than a malformed request. Kept HERE (not in
 * core/shared/errors.ts) because the failover layer has no content_filter
 * category — retrying or failing over a refusal is pointless.
 */
export function isContentFilterBody(body: string): boolean {
  return (
    /content[ _-]?(?:policy|filter|moderation)/i.test(body) ||
    /\bmoderation\b|\bflagged\b.*\b(?:content|policy|safety)\b/i.test(body) ||
    /violat(?:es|ing|ion of).{0,40}(?:usage|content|acceptable use) polic/i.test(body) ||
    /\brefus(?:ed|al)\b.{0,40}\b(?:safety|policy|content)\b/i.test(body) ||
    /\bsafety (?:system|filter|reasons?)\b|\bblocked by (?:the )?(?:safety|content)\b/i.test(body)
  );
}

// ---------------------------------------------------------------------------
// HTTP classification
// ---------------------------------------------------------------------------

/**
 * Classify a non-2xx HTTP provider/gateway response. Delegates status+body
 * disambiguation to categorizeError (billing-on-429, Cloudflare-403-as-
 * overloaded, 400-overflow, …) and adds the one dimension that layer lacks:
 * content-filter refusals.
 */
export function classifyHttpError(status: number, body?: string): LLMErrorClass {
  // A refusal can arrive on 400/403 — categorizeError would call it
  // invalid_request/auth and something might retry or fail over. Sniff first.
  if (body !== undefined && isContentFilterBody(body)) return 'content_filter';
  return CATEGORY_TO_CLASS[categorizeError(status, body)];
}

// ---------------------------------------------------------------------------
// "Provider lies" — HTTP 200 whose parsed IRResponse is an error
// ---------------------------------------------------------------------------

/**
 * Classify a PARSED IRResponse that came back on HTTP 200. Returns null when
 * the response is fine (no error to classify).
 *
 * - extra.provider_bug === true → 'provider_bug' (200-but-garbage: no
 *   choices / empty content — set by parseOpenAIResponse/parseAnthropicResponse).
 * - extra.reason names a content filter / refusal → 'content_filter'.
 * - stop_reason 'error' with neither marker → 'unknown'.
 */
function classifyIRResponse(res: IRResponse): LLMErrorClass | null {
  const extra = res.extra ?? {};
  if (extra['provider_bug'] === true) return 'provider_bug';
  const reason = typeof extra['reason'] === 'string' ? extra['reason'] : '';
  // OpenAI finish_reason 'content_filter'; Anthropic stop_reason 'refusal'.
  if (reason === 'content_filter' || reason === 'refusal') return 'content_filter';
  if (res.stop_reason === 'error') return 'unknown';
  return null;
}

/** OpenAI-wire variant (extra.reason === 'content_filter'). */
export function classifyOpenAIResponse(res: IRResponse): LLMErrorClass | null {
  return classifyIRResponse(res);
}

/** Anthropic-wire variant (extra.reason === 'refusal'). */
export function classifyAnthropicResponse(res: IRResponse): LLMErrorClass | null {
  return classifyIRResponse(res);
}

// ---------------------------------------------------------------------------
// Thrown values
// ---------------------------------------------------------------------------

const NETWORK_MESSAGE = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|network error|getaddrinfo/i;
const TIMEOUT_MESSAGE = /ETIMEDOUT|\btimed? ?out\b/i;

/**
 * Classify a thrown value (network failure, abort, LLMError, HTTP error with
 * a `.status` property, …). Fallback is 'unknown', never a throw.
 */
export function classifyThrown(err: unknown): LLMErrorClass {
  if (err instanceof LLMPolicyError) return err.class;

  if (err instanceof LLMError) {
    if (err.code === 'llm_context_overflow') return 'context_exceeded';
    return 'unknown';
  }

  if (err instanceof Error) {
    // AbortError / undici TimeoutError — a deadline fired, not a broken pipe.
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';

    // Errors that carry an HTTP status (e.g. embed() attaches `.status`).
    const status = (err as Error & { status?: unknown }).status;
    if (typeof status === 'number') return classifyHttpError(status, err.message);

    // Walk message + cause (undici wraps the syscall error in `cause`).
    const cause = (err as Error & { cause?: unknown }).cause;
    const text = `${err.message} ${
      cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause ?? '')
    } ${typeof (err as Error & { code?: unknown }).code === 'string' ? String((err as Error & { code?: unknown }).code) : ''}`;
    if (TIMEOUT_MESSAGE.test(text)) return 'timeout';
    if (err instanceof TypeError && /fetch failed/i.test(text)) return 'network';
    if (NETWORK_MESSAGE.test(text)) return 'network';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// LLMPolicyError
// ---------------------------------------------------------------------------

/**
 * The one error type src/llm/policy.ts throws. Carries the taxonomy class,
 * whether the failure is retryable, and (for policy decisions like an open
 * breaker or a blown budget) `skipped: true` — the call never left the box.
 */
export class LLMPolicyError extends Error {
  public override readonly name = 'LLMPolicyError';
  public readonly class: LLMErrorClass;
  public readonly status?: number;
  public readonly route?: string;
  public readonly retryable: boolean;
  /** True when policy skipped the call (breaker open / budget / halt) — no attempt was made. */
  public readonly skipped: boolean;
  /** Structured extras (e.g. xai-oauth 403 → { tier_gated: true }). */
  public readonly extra?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      class: LLMErrorClass;
      status?: number;
      route?: string;
      retryable?: boolean;
      skipped?: boolean;
      cause?: unknown;
      extra?: Record<string, unknown>;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    Object.setPrototypeOf(this, new.target.prototype);
    this.class = opts.class;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.route !== undefined) this.route = opts.route;
    this.retryable = opts.retryable ?? isRetryable(opts.class);
    this.skipped = opts.skipped ?? false;
    if (opts.extra !== undefined) this.extra = opts.extra;
  }
}
