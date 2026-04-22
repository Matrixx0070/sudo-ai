/**
 * gateway/rpc-types.ts
 *
 * Pure TypeScript types for the WebSocket JSON-RPC layer.
 * No runtime dependencies — safe to import from any module.
 *
 * Protocol:
 *   Client → Server: RpcRequest
 *   Server → Client: RpcResponse | RpcEvent
 */

// ---------------------------------------------------------------------------
// Core message shapes
// ---------------------------------------------------------------------------

/** A JSON-RPC–style request sent from the client to the server. */
export interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC–style response sent from the server back to the client. */
export interface RpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

/** A server-initiated push event (no id — not a reply to a request). */
export interface RpcEvent {
  readonly type: 'event';
  readonly event: string;
  readonly data: unknown;
}

/** Union of all message shapes that travel over the WebSocket. */
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

// ---------------------------------------------------------------------------
// Supported method names (type-safe routing key)
// ---------------------------------------------------------------------------

export type RpcMethod =
  | 'chat.send'
  | 'chat.abort'
  | 'sessions.list'
  | 'sessions.send'
  | 'cron.add'
  | 'cron.list'
  | 'cron.remove'
  | 'tools.catalog'
  | 'health';

// ---------------------------------------------------------------------------
// Per-method param interfaces
// ---------------------------------------------------------------------------

/** chat.send — send a user message and start an agent loop turn. */
export interface ChatSendParams {
  /** Session ID to send the message into. */
  readonly sessionId: string;
  /** The user message text. */
  readonly message: string;
  /** Optional model override (e.g. 'claude-3-5-sonnet'). */
  readonly model?: string;
  /** Whether to stream partial tokens back as RpcEvent messages. */
  readonly stream?: boolean;
}

/** chat.abort — cancel an in-progress agent turn. */
export interface ChatAbortParams {
  /** Session ID whose current turn should be aborted. */
  readonly sessionId: string;
}

/** sessions.list — no parameters required. */
export type SessionsListParams = Record<string, never>;

/** sessions.send — alias for chat.send; kept for REST parity. */
export type SessionsSendParams = ChatSendParams;

/** cron.add — schedule a recurring or one-shot job. */
export interface CronAddParams {
  /** Human-readable label for the job. */
  readonly name: string;
  /** Cron expression (e.g. '0 * * * *') or ISO date string for one-shot. */
  readonly schedule: string;
  /** The instruction/prompt the agent will run when triggered. */
  readonly prompt: string;
  /** Optional session ID to run the job inside. */
  readonly sessionId?: string;
}

/** cron.list — no parameters required. */
export type CronListParams = Record<string, never>;

/** cron.remove — cancel and delete a scheduled job. */
export interface CronRemoveParams {
  /** The job ID returned by cron.add. */
  readonly jobId: string;
}

/** tools.catalog — no parameters required. */
export type ToolsCatalogParams = Record<string, never>;

/** health — no parameters required. */
export type HealthParams = Record<string, never>;

// ---------------------------------------------------------------------------
// Handler function type
// ---------------------------------------------------------------------------

/** Signature every RPC handler must satisfy. */
export type RpcHandlerFn = (params: unknown) => Promise<unknown>;
