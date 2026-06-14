/**
 * @file acp/types.ts
 * @description Agent Client Protocol (ACP) wire types.
 *
 * ACP (https://agentclientprotocol.com) is an open JSON-RPC 2.0 protocol that
 * lets any editor talk to any coding agent — the "LSP for agents". sudo-ai
 * implements the AGENT side: an editor (e.g. Zed) launches sudo-ai as a
 * subprocess and drives it over newline-delimited JSON-RPC on stdio.
 *
 * Slice 1 covers the core chat loop: initialize → session/new → session/prompt
 * with streamed agent_message_chunk updates. Only the `text` ContentBlock is
 * produced/consumed; image/audio/resource blocks and the fs/terminal/permission
 * client methods are follow-up slices.
 */

/** MAJOR protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** Why a prompt turn ended (session/prompt result). */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** Text content block — the only variant slice 1 emits/reads. */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** A content block; non-text variants are tolerated but ignored in slice 1. */
export type ContentBlock = TextContentBlock | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; title?: string; version?: string };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  };
  agentInfo: { name: string; version: string };
  authMethods: unknown[];
}

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

export interface NewSessionParams {
  cwd?: string;
  mcpServers?: unknown[];
}

export interface NewSessionResult {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface PromptResult {
  stopReason: StopReason;
}

// ---------------------------------------------------------------------------
// session/cancel (notification)
// ---------------------------------------------------------------------------

export interface CancelParams {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// session/update (notification: agent → client)
// ---------------------------------------------------------------------------

/** The only session/update variant slice 1 emits. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: TextContentBlock;
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: AgentMessageChunkUpdate;
}
