/**
 * @file bridge-protocol.ts
 * @description SUDO-AI IDE Bridge Protocol — shared type definitions.
 *
 * Pure TypeScript types with ZERO runtime dependencies.
 * Importable by both the SUDO-AI server and IDE extensions (VS Code, JetBrains).
 *
 * Protocol version: 1
 * Transport: WebSocket at /ide/bridge
 * Auth: GATEWAY_TOKEN for initial connection, per-session JWT for subsequent messages.
 */

// ---------------------------------------------------------------------------
// Protocol Version
// ---------------------------------------------------------------------------

/** Bridge protocol version. Increment on breaking changes. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Connection Lifecycle
// ---------------------------------------------------------------------------

/** Phase of a bridge connection. */
export type BridgeConnectionPhase =
  | 'connecting'     // WS handshake in progress
  | 'initializing'    // client sent initialize, awaiting server response
  | 'ready'           // fully operational
  | 'reconnecting'   // client lost connection, attempting reconnect
  | 'closing';       // graceful shutdown in progress

/** Multiplexing mode for IDE tabs sharing one bridge connection. */
export type BridgeMultiplexMode =
  | 'single-session'  // one SUDO-AI session per connection (simplest)
  | 'worktree'        // sessions mapped to git worktrees
  | 'same-dir';       // sessions share working directory, distinguished by tab ID

// ---------------------------------------------------------------------------
// Message Envelope
// ---------------------------------------------------------------------------

/** Client → Server message envelope (JSON-RPC style). */
export interface BridgeClientMessage {
  /** Unique request ID for correlating responses. */
  id: string;
  /** Method name. */
  method: BridgeMethod;
  /** Method parameters. */
  params?: unknown;
}

/** Server → Client response envelope. */
export interface BridgeServerResponse {
  /** Echoes the client's request ID. */
  id: string;
  /** Result on success. */
  result?: unknown;
  /** Error on failure. */
  error?: BridgeError;
}

/** Server → Client push event (no request ID, server-initiated). */
export interface BridgeServerEvent {
  /** Event name. */
  event: BridgeEventType;
  /** Event payload. */
  data: unknown;
}

/** Union type for all server → client messages. */
export type BridgeServerMessage = BridgeServerResponse | BridgeServerEvent;

// ---------------------------------------------------------------------------
// Methods (Client → Server)
// ---------------------------------------------------------------------------

/** All methods the IDE client can call. */
export type BridgeMethod =
  // Lifecycle
  | 'initialize'
  | 'shutdown'
  // Messaging
  | 'chat.send'
  | 'chat.abort'
  // Control
  | 'set_model'
  | 'set_permission_mode'
  | 'can_use_tool'
  | 'interrupt'
  // Session
  | 'session.create'
  | 'session.list'
  | 'session.archive';

// ---------------------------------------------------------------------------
// Events (Server → Client, pushed)
// ---------------------------------------------------------------------------

/** All event types the server can push to the IDE client. */
export type BridgeEventType =
  // Streaming
  | 'stream.start'
  | 'stream.token'
  | 'stream.thinking'
  | 'stream.tool_call'
  | 'stream.tool_result'
  | 'stream.complete'
  | 'stream.error'
  // Session lifecycle
  | 'session.created'
  | 'session.archived'
  // Control acknowledgements
  | 'model.changed'
  | 'permission_mode.changed'
  | 'tool.approved'
  | 'tool.denied'
  // Connection
  | 'heartbeat';

// ---------------------------------------------------------------------------
// Error Codes
// ---------------------------------------------------------------------------

/** Bridge protocol error codes (negative to distinguish from JSON-RPC standard). */
export const BridgeErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  AUTH_FAILED: -32001,
  SESSION_NOT_FOUND: -32002,
  SESSION_EXPIRED: -32003,
  EPOCH_MISMATCH: -32004,
  RATE_LIMIT: -32005,
  CONNECTION_LIMIT: -32006,
  AGENT_LOOP_UNAVAILABLE: -32007,
  INTERRUPT_FAILED: -32008,
  TOOL_APPROVAL_TIMEOUT: -32009,
  PERMISSION_DENIED: -32010,
} as const;

export type BridgeErrorCodeType = typeof BridgeErrorCode[keyof typeof BridgeErrorCode];

/** Bridge error structure. */
export interface BridgeError {
  code: BridgeErrorCodeType;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Initialize (handshake)
// ---------------------------------------------------------------------------

export interface InitializeParams {
  /** Client identifier (e.g. 'vscode/1.92.0 sudo-ai-ext/0.1.0'). */
  clientInfo: { name: string; version: string };
  /** Capabilities the client supports. */
  capabilities: BridgeClientCapabilities;
  /** Multiplexing mode. */
  multiplexMode: BridgeMultiplexMode;
  /** Working directory for this connection. */
  workdir?: string;
}

export interface InitializeResult {
  /** Server identifier. */
  serverInfo: { name: string; version: string };
  /** Server capabilities. */
  capabilities: BridgeServerCapabilities;
  /** Session ID assigned to this connection (or primary session). */
  sessionId: string;
  /** Per-session JWT for subsequent messages. */
  sessionJwt: string;
  /** JWT expiry (epoch ms). */
  tokenExpiresAt: number;
  /** Server epoch (incremented on restart). */
  epoch: number;
}

export interface BridgeClientCapabilities {
  /** Can receive token-by-token streaming? Default true. */
  streaming?: boolean;
  /** Can receive can_use_tool requests? */
  toolApproval?: boolean;
  /** Can manage multiple worktree sessions? */
  worktreeSupport?: boolean;
  /** Client's preferred heartbeat interval in ms. */
  heartbeatIntervalMs?: number;
}

export interface BridgeServerCapabilities {
  /** Server always supports streaming. */
  streaming: boolean;
  /** Can interrupt an in-progress agent turn. */
  interrupt: boolean;
  /** Can request tool approval from client. */
  toolApproval: boolean;
  /** Available model IDs. */
  models: string[];
  /** Available permission modes. */
  permissionModes: string[];
  /** Max concurrent sessions per connection. */
  maxSessions: number;
}

// ---------------------------------------------------------------------------
// Chat Send (with streaming)
// ---------------------------------------------------------------------------

export interface BridgeChatSendParams {
  sessionId: string;
  message: string;
  /** If true, server sends stream.* events instead of awaiting full result. */
  stream?: boolean;
  /** Model override for this turn only. */
  model?: string;
  /** Permission mode for this turn. */
  permissionMode?: string;
}

export interface BridgeChatSendResult {
  sessionId: string;
  /** Non-streaming only: full response text. */
  text?: string;
  attachments?: unknown[];
}

// ---------------------------------------------------------------------------
// Control Methods
// ---------------------------------------------------------------------------

export interface SetModelParams {
  sessionId: string;
  model: string;
}

export interface SetPermissionModeParams {
  sessionId: string;
  mode: string; // 'ask' | 'auto' | 'restricted'
}

export interface CanUseToolParams {
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Whether the user approved or denied the tool use. */
  approved?: boolean;
  /** Reason for denial (if denied). */
  reason?: string;
}

export interface CanUseToolResult {
  allowed: boolean;
  reason?: string;
}

export interface InterruptParams {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Streaming Events (granular)
// ---------------------------------------------------------------------------

export interface StreamStartEvent {
  sessionId: string;
  /** Server-assigned turn ID to correlate start/complete. */
  turnId: string;
  model: string;
}

export interface StreamTokenEvent {
  sessionId: string;
  turnId: string;
  /** Incremental text delta (not full-so-far). */
  delta: string;
  /** Token index (monotonically increasing). */
  index: number;
}

export interface StreamThinkingEvent {
  sessionId: string;
  turnId: string;
  /** Thinking text (may be partial). */
  text: string;
  /** True if this is the final thinking chunk for this turn. */
  done: boolean;
}

export interface StreamToolCallEvent {
  sessionId: string;
  turnId: string;
  toolName: string;
  toolId: string;
  args: Record<string, unknown>;
  /** Whether this tool call requires user approval. */
  requiresApproval?: boolean;
}

export interface StreamToolResultEvent {
  sessionId: string;
  turnId: string;
  toolName: string;
  toolId: string;
  result: unknown;
  /** Whether the tool call was approved by the user. */
  approved?: boolean;
}

export interface StreamCompleteEvent {
  sessionId: string;
  turnId: string;
  /** Total elapsed ms. */
  elapsedMs: number;
  /** Token count for the response. */
  tokensGenerated?: number;
  /** Whether the turn was interrupted. */
  interrupted?: boolean;
}

export interface StreamErrorEvent {
  sessionId: string;
  turnId: string;
  error: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface HeartbeatEvent {
  serverTime: number;
  /** Monotonically increasing epoch counter (incremented on server restart). */
  epoch: number;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Written to ~/.sudo-ai/bridge.json for IDE extension discovery. */
export interface BridgeDiscoveryPayload {
  /** Protocol version. */
  version: number;
  /** HTTP base URL (e.g. http://127.0.0.1:18900). */
  url: string;
  /** WebSocket URL for the bridge (e.g. ws://127.0.0.1:18900/ide/bridge). */
  wsUrl: string;
  /** Port the gateway is listening on. */
  port: number;
  /** Process PID (for lifecycle management). */
  pid: number;
  /** Server start epoch (ms). */
  startedAt: number;
  /** Available models (if configured). */
  models?: string[];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface BridgeSessionCreateParams {
  /** Tab identifier for multiplexing (VS Code tab ID). */
  tabId?: string;
  /** Working directory override. */
  workdir?: string;
}

export interface BridgeSessionCreateResult {
  sessionId: string;
  peerId: string;
}

export interface BridgeSessionInfo {
  sessionId: string;
  peerId: string;
  channel: string;
  createdAt: string;
  messageCount: number;
}

export interface BridgeSessionArchiveParams {
  sessionId: string;
}