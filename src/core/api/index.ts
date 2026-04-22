/**
 * OpenAI-compatible HTTP API — barrel export.
 *
 * Public surface of the SUDO-AI HTTP API module.
 */

export type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionChunk,
  CompletionUsage,
  ModelsListResponse,
  ModelObject,
  RateLimitEntry,
} from './types.js';

export { HttpServer } from './http-server.js';
export type { HttpServerOptions } from './http-server.js';

export { RateLimiter } from './rate-limiter.js';

export {
  validateChatRequest,
  toBrainMessages,
  handleNonStreaming,
  handleStreaming,
} from './handlers.js';

// Upgrade 39: Responses API Format
export {
  createResponse,
  completeResponse,
  failResponse,
  cancelResponse,
} from './responses-api.js';
export type {
  ResponseEvent,
  ResponseObject,
  ResponseOutput,
} from './responses-api.js';
