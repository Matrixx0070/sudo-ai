/**
 * OpenAI-compatible HTTP API type definitions.
 *
 * These types mirror the OpenAI Chat Completions API so that any client
 * written for OpenAI works with the SUDO-AI HTTP server without modification.
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** A single message in an OpenAI-compatible chat request. */
export interface ChatMessage {
  /** One of: "system" | "user" | "assistant" | "tool". */
  role: string;
  /** Message text content. */
  content: string;
  /** Present when role === "tool". */
  tool_call_id?: string;
  /** Present when role === "assistant" and tool calls were made. */
  tool_calls?: unknown[];
}

/**
 * POST /v1/chat/completions request body.
 * Mirrors https://platform.openai.com/docs/api-reference/chat/create
 */
export interface ChatCompletionRequest {
  /** Model identifier, e.g. "gpt-4o" or "xai/grok-3". */
  model: string;
  /** Ordered conversation messages. */
  messages: ChatMessage[];
  /** Sampling temperature (0–2). */
  temperature?: number;
  /** Maximum tokens to generate. */
  max_tokens?: number;
  /** Enable server-sent-events streaming. */
  stream?: boolean;
  /** Tool/function definitions forwarded to the LLM. */
  tools?: unknown[];
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** A single completion choice. */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string;
    tool_calls?: unknown[];
  };
  /** Reason the model stopped: "stop" | "tool_calls" | "length" | "content_filter". */
  finish_reason: string;
}

/** Token usage for a completion. */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * POST /v1/chat/completions response body (non-streaming).
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: CompletionUsage;
}

// ---------------------------------------------------------------------------
// Streaming chunk
// ---------------------------------------------------------------------------

/** A single SSE chunk for streaming completions. */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------

/** A single model entry from GET /v1/models. */
export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** GET /v1/models response. */
export interface ModelsListResponse {
  object: 'list';
  data: ModelObject[];
}

// ---------------------------------------------------------------------------
// Internal: rate limiter state
// ---------------------------------------------------------------------------

/** In-memory rate-limit entry per client IP. */
export interface RateLimitEntry {
  count: number;
  /** Unix ms timestamp when the window resets. */
  resetAt: number;
}
