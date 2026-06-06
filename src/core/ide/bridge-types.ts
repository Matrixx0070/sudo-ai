/**
 * @file bridge-types.ts
 * @description Server-side types for the IDE Bridge — extends shared protocol types
 * with internal state and dependency injection types.
 *
 * @module ide-bridge-types
 */

import type { WebSocket } from 'ws';
import type {
  BridgeConnectionPhase,
  BridgeMultiplexMode,
  BridgeClientCapabilities,
  BridgeServerCapabilities,
  BridgeErrorCodeType,
} from '../../../shared-types/bridge-protocol.js';

// ---------------------------------------------------------------------------
// Bridge Connection State
// ---------------------------------------------------------------------------

/** Pending tool-approval request from IDE client. */
export interface PendingToolApproval {
  /** Unique approval request ID. */
  id: string;
  /** Tool name being requested. */
  toolName: string;
  /** Tool arguments. */
  toolArgs: Record<string, unknown>;
  /** Session ID that requested approval. */
  sessionId: string;
  /** Timestamp when the request was created. */
  createdAt: number;
  /** Resolves when the client responds (true=approved, false=denied). */
  resolve: (approved: boolean, reason?: string) => void;
  /** Rejects if the approval times out. */
  reject: (error: Error) => void;
}

/** Server-side state for a single bridge WebSocket connection. */
export interface BridgeConnection {
  /** Unique connection identifier (used as peerId in UnifiedMessage). */
  peerId: string;
  /** Underlying WebSocket. */
  ws: WebSocket;
  /** Current connection phase. */
  phase: BridgeConnectionPhase;
  /** Server epoch at the time of initialization. */
  epoch: number;
  /** Per-session JWT issued during initialize. */
  sessionJwt: string;
  /** JWT expiry timestamp (epoch ms). */
  tokenExpiresAt: number;
  /** Client capabilities from initialize handshake. */
  capabilities: BridgeClientCapabilities | null;
  /** Multiplexing mode. */
  multiplexMode: BridgeMultiplexMode;
  /** ISO timestamp of last heartbeat received. */
  lastHeartbeat: number;
  /** Map of pending tool approval requests (approval ID → request). */
  pendingApprovals: Map<string, PendingToolApproval>;
  /** AbortController for the currently running agent turn (null when idle). */
  abortController: AbortController | null;
  /** Primary session ID assigned during initialize. */
  primarySessionId: string | null;
  /** Additional session IDs for multiplexed connections (tabId → sessionId). */
  sessions: Map<string, string>;
  /** ISO timestamp when the connection was established. */
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Bridge Router Dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal interface for SessionManager — decouples bridge from concrete impl.
 * Matches both SessionManager and DualSessionManager.
 */
export interface SessionManagerLike {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string; channel: string; peerId: string; state: string; model?: string; messages: unknown[]; createdAt: Date; updatedAt: Date }>;
  get(sessionId: string): Promise<{ id: string; channel: string; peerId: string; state: string; model?: string; messages: unknown[]; createdAt: Date; updatedAt: Date } | undefined>;
  save(session: { id: string; channel: string; peerId: string; state: string; model?: string; messages: unknown[]; createdAt: Date; updatedAt: Date }): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

/**
 * Minimal interface for AgentLoop — decouples bridge from concrete impl.
 * The onEvent callback accepts the full AgentEvent union from the real AgentLoop,
 * but the bridge only processes a subset (see convertAgentEvent in bridge-protocol.ts).
 */
export interface AgentLoopLike {
  run(
    sessionId: string,
    message: string,
    onEvent?: (event: any) => void,
    opts?: { race?: boolean },
  ): Promise<AgentRunResultLike>;
}

/** Subset of AgentEvent types the bridge cares about. */
export type AgentEventLike =
  | { type: 'message'; content: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown>; toolId: string }
  | { type: 'tool-result'; name: string; result: unknown; toolId: string }
  | { type: 'stream-chunk'; chunk: string }
  | { type: 'compaction'; summary: string }
  | { type: 'error'; error: string }
  | { type: 'done' };

/** Result of an agent turn. */
export interface AgentRunResultLike {
  text: string;
  attachments: Array<{ type: string; path: string; filename?: string }>;
}

/**
 * Minimal interface for ProgressBroadcaster — decouples bridge from concrete impl.
 */
export interface ProgressBroadcasterLike {
  subscribe(sessionId: string, listener: (event: ProgressEventLike) => void): () => void;
  emit(event: ProgressEventLike): void;
}

/** Subset of ProgressEvent types. */
export interface ProgressEventLike {
  type: string;
  sessionId: string;
  message: string;
  timestamp: number;
  provider?: string;
  tokensGenerated?: number;
  elapsedMs?: number;
}

/**
 * Minimal interface for HookManager — decouples bridge from concrete impl.
 * Uses any-typed parameters for compatibility with the full HookManager signature.
 */
export interface HookManagerLike {
  emit(event: any, context: any): Promise<void>;
}

// ---------------------------------------------------------------------------
// Bridge Configuration
// ---------------------------------------------------------------------------

/** Configuration for the IDE Bridge adapter. */
export interface BridgeConfig {
  /** Gateway token for initial connection auth. Read from GATEWAY_TOKEN env var if not set. */
  gatewayToken?: string;
  /** JWT TTL in milliseconds. Default: 3600000 (1 hour). */
  jwtTtlMs?: number;
  /** Heartbeat ping interval in milliseconds. Default: 20000 (20s). */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout in milliseconds. Default: 60000 (60s). */
  heartbeatTimeoutMs?: number;
  /** Max payload size for WebSocket messages in bytes. Default: 2MB. */
  maxPayloadBytes?: number;
  /** Path for the bridge WebSocket endpoint. Default: '/ide/bridge'. */
  path?: string;
  /** Port file path. Default: '~/.sudo-ai/bridge.json'. */
  portFilePath?: string;
  /** Whether to advertise via mDNS. Default: true. */
  mdnsEnabled?: boolean;
  /** Kill switch. If true, the bridge is disabled entirely. Read from SUDO_IDE_BRIDGE_DISABLE. */
  disabled?: boolean;
}

export const DEFAULT_BRIDGE_CONFIG: Required<Omit<BridgeConfig, 'gatewayToken'>> = {
  jwtTtlMs: 3_600_000,
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 60_000,
  maxPayloadBytes: 2 * 1024 * 1024, // 2MB
  path: '/ide/bridge',
  portFilePath: '', // resolved at runtime to ~/.sudo-ai/bridge.json
  mdnsEnabled: true,
  disabled: false,
};

// ---------------------------------------------------------------------------
// Bridge Method Handler
// ---------------------------------------------------------------------------

/** Result of a bridge method handler. */
export interface BridgeMethodResult {
  result?: unknown;
  error?: {
    code: BridgeErrorCodeType;
    message: string;
    data?: unknown;
  };
}

/** Context provided to method handlers. */
export interface BridgeMethodContext {
  connection: BridgeConnection;
  params: unknown;
  deps: BridgeRouterDeps;
}

/** A handler for a bridge method. */
export type BridgeMethodHandler = (ctx: BridgeMethodContext) => Promise<BridgeMethodResult>;

// ---------------------------------------------------------------------------
// Bridge Router Dependencies (injected into adapter)
// ---------------------------------------------------------------------------

/** All external dependencies the bridge router needs. */
export interface BridgeRouterDeps {
  sessionManager: SessionManagerLike;
  agentLoop: AgentLoopLike;
  progressBroadcaster: ProgressBroadcasterLike;
  hookManager: HookManagerLike;
}