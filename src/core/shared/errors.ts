/**
 * Custom error hierarchy for SUDO-AI.
 * All errors extend SudoError, which carries a machine-readable `code` and
 * optional structured `details` for downstream logging/routing.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Base error class for all SUDO-AI errors. */
export class SudoError extends Error {
  public readonly name: string = 'SudoError';

  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    // Restore prototype chain (required when extending built-ins in TS).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

/** Errors originating from LLM providers (codes: llm_*). */
export class LLMError extends SudoError {
  public override readonly name = 'LLMError';

  constructor(message: string, code: `llm_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from tool execution (codes: tool_*). */
export class ToolError extends SudoError {
  public override readonly name = 'ToolError';

  constructor(message: string, code: `tool_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from channel adapters (codes: channel_*). */
export class ChannelError extends SudoError {
  public override readonly name = 'ChannelError';

  constructor(message: string, code: `channel_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors from config loading or validation (codes: config_*). */
export class ConfigError extends SudoError {
  public override readonly name = 'ConfigError';

  constructor(message: string, code: `config_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors from the memory / vector-store layer (codes: memory_*). */
export class MemoryError extends SudoError {
  public override readonly name = 'MemoryError';

  constructor(message: string, code: `memory_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors from the agent pipeline or orchestration (codes: pipeline_*). */
export class PipelineError extends SudoError {
  public override readonly name = 'PipelineError';

  constructor(message: string, code: `pipeline_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from browser automation tools (codes: browser_*). */
export class BrowserError extends SudoError {
  public override readonly name = 'BrowserError';

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, `browser_${code}`, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors originating from system-level tools, e.g. shell commands (codes: system_*). */
export class SystemError extends SudoError {
  public override readonly name = 'SystemError';

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, `system_${code}`, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors from knowledge-base or retrieval tools (codes: knowledge_*). */
export class KnowledgeError extends SudoError {
  public override readonly name = 'KnowledgeError';

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, `knowledge_${code}`, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Errors from business-logic or integration tools (codes: business_*). */
export class BusinessError extends SudoError {
  public override readonly name = 'BusinessError';

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, `business_${code}`, details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Error categories (used by the LLM failover / backoff system)
// ---------------------------------------------------------------------------

/**
 * Categorical classification of HTTP errors returned by LLM providers.
 * Used by the failover system to decide on retry strategy and cooldown duration.
 */
export type ErrorCategory =
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'auth'
  | 'auth_permanent'
  | 'timeout'
  | 'format'
  | 'model_not_found'
  | 'session_expired'
  | 'context_overflow';

/**
 * Map an HTTP status code (and optional response body) to an ErrorCategory.
 *
 * | Status | Category        |
 * |--------|-----------------|
 * | 402    | billing         |
 * | 429    | rate_limit      |
 * | 503    | overloaded      |
 * | 401    | auth            |
 * | 403    | auth_permanent  |
 * | 408    | timeout         |
 * | 400    | format          |
 * | 404    | model_not_found |
 * | 410    | session_expired |
 *
 * @param status - HTTP status code from the provider response.
 * @param body   - Optional response body string for additional disambiguation.
 * @returns The matching ErrorCategory, or `'format'` as a safe default.
 */
/**
 * Whether an error body names a quota/billing/credit problem — i.e. the
 * credential is valid but the account is out of budget. Used to reclassify an
 * auth-status (401/403) or a 429 as `billing` so failover fails OVER to the next
 * provider instead of cooling down / permanently disabling a healthy profile.
 * Covers common English wordings plus a few CJK provider phrasings.
 */
export function isBillingBody(body: string): boolean {
  return (
    /insufficient.?(?:quota|credit|credits|balance|funds)/i.test(body) ||
    /exceeded.*(?:quota|credit|credits|budget)/i.test(body) ||
    /\bkey limit\b|\bcredit limit\b|\bquota (?:exceeded|exhausted)\b/i.test(body) ||
    /\bpayment required\b|\bbilling\b|\bout of credit\b|\bnegative balance\b/i.test(body) ||
    /余额不足|额度不足|欠费/.test(body)
  );
}

/**
 * Whether an error body is a transient infrastructure block — an HTML error page
 * or a Cloudflare/proxy challenge — rather than a real decision from the LLM
 * provider. These arrive with auth-ish statuses (401/403) but the credential is
 * fine; a CDN/gateway is in the way. Left as `auth`/`auth_permanent` a Cloudflare
 * 403 would PERMANENTLY DISABLE the profile (see failover.ts), so we reclassify
 * to `overloaded` (transient cooldown, retryable). Gated strictly on HTML/challenge
 * markers so a real JSON `permission_error` body still maps to auth_permanent.
 */
export function isTransientHtmlBlockBody(body: string): boolean {
  return (
    /<!doctype html|<html[\s>]|<\/html>/i.test(body) ||
    /\bcf-ray\b|cloudflare|attention required|just a moment|checking your browser|ddos protection/i.test(body) ||
    /\b(?:bad gateway|gateway time-?out)\b|\b50[234]\b\s*(?:bad gateway|gateway|unavailable)/i.test(body)
  );
}

/**
 * Whether an error body reports that the prompt exceeded the model's context
 * window (input too large), as opposed to an output-length cap or a TPM rate
 * limit (which also mention "tokens" and must NOT be treated as overflow — they
 * need backoff, not compaction). An overflow persists across a same-family
 * failover, so classifying it distinctly lets the loop compact instead of blindly
 * re-sending the same oversized prompt to every profile.
 */
export function isContextOverflowBody(body: string): boolean {
  if (/tokens?[ _-]?per[ _-]?min|per[ _-]minute|\btpm\b|requests? per/i.test(body)) return false;
  return (
    /prompt is too long|maximum context length|context[_ ]?length[_ ]?exceeded/i.test(body) ||
    /input length and max_tokens exceed context/i.test(body) ||
    /reduce the (?:length|number) of|context window (?:is )?exceeded/i.test(body) ||
    /\b\d{3,}\s*tokens?\s*>\s*\d{3,}/i.test(body)
  );
}

/**
 * Best-effort parse of the observed prompt token count from an overflow error,
 * so a caller can size compaction. Handles "N tokens > M" and "A + B > L" forms.
 */
export function extractOverflowTokenCount(body: string): number | undefined {
  const gt = /(\d{3,})\s*tokens?\s*>\s*\d{3,}/i.exec(body);
  if (gt) return parseInt(gt[1]!, 10);
  const sum = /(\d{3,})\s*\+\s*(\d{3,})\s*>\s*\d{3,}/.exec(body);
  if (sum) return parseInt(sum[1]!, 10) + parseInt(sum[2]!, 10);
  return undefined;
}

export function categorizeError(status: number, body?: string): ErrorCategory {
  if (typeof status !== 'number') {
    return 'format';
  }

  switch (status) {
    case 402:
      return 'billing';
    case 429:
      // OpenAI returns 429 for both rate-limits AND exhausted quota.
      // "insufficient_quota" is a billing problem, not a transient rate limit.
      if (body && isBillingBody(body)) return 'billing';
      return 'rate_limit';
    case 503:
      return 'overloaded';
    case 401:
      // A quota/billing failure can arrive on an AUTH status: OpenRouter sends
      // "Key limit exceeded" / "insufficient credits" as 401/403. Left as 'auth'
      // it would park the profile on a long re-auth cooldown (and 403 →
      // auth_permanent PERMANENTLY DISABLES it) — when the right action is to
      // fail OVER to the next provider on a billing cooldown, since the credential
      // is fine, the account is just out of budget. Body billing-signature wins.
      if (body && isBillingBody(body)) return 'billing';
      // A CDN/proxy challenge page (Cloudflare, gateway 5xx-as-HTML) can surface
      // as 401 — the credential is fine, infra is in the way. Retry, don't cooldown.
      if (body && isTransientHtmlBlockBody(body)) return 'overloaded';
      return 'auth';
    case 403:
      if (body && isBillingBody(body)) return 'billing';
      // Same for 403 — and here it matters more: auth_permanent PERMANENTLY
      // DISABLES the profile, so a transient Cloudflare 403 would kill it until
      // process restart. Reclassify an HTML/challenge body to a transient state.
      if (body && isTransientHtmlBlockBody(body)) return 'overloaded';
      return 'auth_permanent';
    case 408:
      return 'timeout';
    case 413:
      // Payload Too Large: context overflow if the body says so, else a TPM/size
      // limit → back off rather than compact.
      if (body && isContextOverflowBody(body)) return 'context_overflow';
      return 'rate_limit';
    case 400:
      // Some providers return 400 for session-expired or model issues;
      // inspect body for disambiguation when available.
      if (body && /session.?expired/i.test(body)) return 'session_expired';
      if (body && /model.?not.?found/i.test(body)) return 'model_not_found';
      // Anthropic returns 400 "prompt is too long: N tokens > M" for overflow.
      if (body && isContextOverflowBody(body)) return 'context_overflow';
      return 'format';
    case 404:
      return 'model_not_found';
    case 410:
      return 'session_expired';
    default:
      // 5xx other than 503 -> treat as transient overload.
      if (status >= 500) return 'overloaded';
      // Anything else is a format/client error.
      return 'format';
  }
}
