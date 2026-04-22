/**
 * Responses API — OpenAI Responses API format (response.created / completed).
 *
 * Models the event-driven response lifecycle used by Codex and GPT-5.x APIs.
 * Consumers emit ResponseEvent values over SSE or WebSocket channels.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('api:responses');

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/** Lifecycle event types emitted during a response run. */
export type ResponseEvent =
  | 'response.created'
  | 'response.completed'
  | 'response.failed'
  | 'response.cancelled';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A single item in the response output array. */
export interface ResponseOutput {
  /** Discriminant: message text, a tool invocation, or a tool result. */
  type: 'message' | 'tool_call' | 'tool_result';
  /** Textual content (for type "message" or "tool_result"). */
  content?: string;
  /** Message role (e.g. "assistant"). */
  role?: string;
  /** Name of the tool being called (for type "tool_call"). */
  tool_name?: string;
  /** Arguments passed to the tool (for type "tool_call"). */
  tool_args?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core response object
// ---------------------------------------------------------------------------

/** The top-level response object, aligned with the OpenAI Responses API spec. */
export interface ResponseObject {
  /** Unique response identifier, e.g. "resp_abc123". */
  id: string;
  /** Always "response". */
  object: 'response';
  /** Current lifecycle status. */
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  /** Model that produced this response. */
  model: string;
  /** Ordered list of output items produced during the run. */
  output: ResponseOutput[];
  /** Token usage statistics (populated on completion). */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 completion timestamp (set when status reaches a terminal state). */
  completed_at?: string;
  /** Error detail when status is "failed". */
  error?: {
    message: string;
    code: string;
  };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a new in-progress response object for the given model.
 *
 * @param model - Model identifier string.
 * @returns A ResponseObject with status "in_progress".
 * @throws {Error} When model is empty.
 */
export function createResponse(model: string): ResponseObject {
  if (!model || typeof model !== 'string') {
    throw new Error('createResponse: model must be a non-empty string');
  }

  const response: ResponseObject = {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    status: 'in_progress',
    model,
    output: [],
    created_at: new Date().toISOString(),
  };

  log.debug({ id: response.id, model }, 'Response created');
  return response;
}

/**
 * Transition a response to "completed" with the given output array.
 *
 * @param response - The in-progress response to complete.
 * @param output   - Ordered list of output items.
 * @returns A new ResponseObject with status "completed".
 */
export function completeResponse(
  response: ResponseObject,
  output: ResponseOutput[],
): ResponseObject {
  if (!response || typeof response !== 'object') {
    throw new Error('completeResponse: response must be a ResponseObject');
  }
  if (!Array.isArray(output)) {
    throw new Error('completeResponse: output must be an array');
  }

  const completed: ResponseObject = {
    ...response,
    status: 'completed',
    output,
    completed_at: new Date().toISOString(),
  };

  log.info({ id: completed.id, outputItems: output.length }, 'Response completed');
  return completed;
}

/**
 * Transition a response to "failed" with an error message.
 *
 * @param response - The in-progress response that failed.
 * @param message  - Human-readable error description.
 * @param code     - Machine-readable error code. Defaults to "internal_error".
 * @returns A new ResponseObject with status "failed".
 */
export function failResponse(
  response: ResponseObject,
  message: string,
  code = 'internal_error',
): ResponseObject {
  if (!response || typeof response !== 'object') {
    throw new Error('failResponse: response must be a ResponseObject');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('failResponse: message must be a non-empty string');
  }

  const failed: ResponseObject = {
    ...response,
    status: 'failed',
    error: { message, code },
    completed_at: new Date().toISOString(),
  };

  log.warn({ id: failed.id, code, message }, 'Response failed');
  return failed;
}

/**
 * Transition a response to "cancelled".
 *
 * @param response - The in-progress response to cancel.
 * @returns A new ResponseObject with status "cancelled".
 */
export function cancelResponse(response: ResponseObject): ResponseObject {
  if (!response || typeof response !== 'object') {
    throw new Error('cancelResponse: response must be a ResponseObject');
  }

  const cancelled: ResponseObject = {
    ...response,
    status: 'cancelled',
    completed_at: new Date().toISOString(),
  };

  log.info({ id: cancelled.id }, 'Response cancelled');
  return cancelled;
}
