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
  | 'session_expired';

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
      if (body && /insufficient.?quota/i.test(body)) return 'billing';
      if (body && /exceeded.*quota/i.test(body)) return 'billing';
      return 'rate_limit';
    case 503:
      return 'overloaded';
    case 401:
      return 'auth';
    case 403:
      return 'auth_permanent';
    case 408:
      return 'timeout';
    case 400:
      // Some providers return 400 for session-expired or model issues;
      // inspect body for disambiguation when available.
      if (body && /session.?expired/i.test(body)) return 'session_expired';
      if (body && /model.?not.?found/i.test(body)) return 'model_not_found';
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
