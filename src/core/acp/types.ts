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
//
// Slice 1 emitted only `agent_message_chunk`. Slice 2 (gap #26) adds the
// reasoning-and-action variants that let an editor render what the agent is
// doing in real time: a `thought` rendered as italic prose, a `tool_call`
// announcing intent (with title, kind, raw input), a `tool_call_update`
// reporting status transitions and final output.
// ---------------------------------------------------------------------------

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: TextContentBlock;
}

/** Free-form internal reasoning the agent wants the client to render distinctly. */
export interface ThoughtUpdate {
  sessionUpdate: 'thought';
  content: TextContentBlock;
}

/** Status of a tool call as the agent transitions it through its lifecycle. */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Tool-call kind hint — clients use this to choose an icon / treatment. */
export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/**
 * One announced tool invocation. `toolCallId` is the agent-chosen stable id;
 * subsequent updates reference the same id. `rawInput` carries the agent's
 * pre-validation arguments; clients may render them but should not assume the
 * agent will execute exactly those.
 */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
  rawInput?: unknown;
}

/**
 * Status / output update for an already-announced tool call. Most fields are
 * optional — clients merge against the prior `tool_call` they saw with the
 * matching `toolCallId`.
 */
export interface ToolCallUpdateUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: ToolCallStatus;
  /** Free-form output rendered by the client; usually short. */
  content?: TextContentBlock[];
  /** Set on failure — typically a one-line cause. */
  rawError?: string;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ThoughtUpdate
  | ToolCallUpdate
  | ToolCallUpdateUpdate;

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

// ---------------------------------------------------------------------------
// session/request_permission (request: agent → client)
//
// Slice 2: when the agent wants to execute a `requiresConfirmation` tool, it
// SENDS this request to the client and awaits the user's choice. The client
// returns one of the option ids that was offered, or rejects with `cancelled`
// if the request was withdrawn.
// ---------------------------------------------------------------------------

/** Behavior the client should associate with an option (UI hint only). */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: string;
  /**
   * The tool_call the agent wants approval for. The client should display
   * `title`/`rawInput` so the user understands what they are approving.
   */
  toolCall: {
    toolCallId: string;
    title: string;
    kind: ToolCallKind;
    rawInput?: unknown;
  };
  options: PermissionOption[];
}

export type RequestPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
}

// ---------------------------------------------------------------------------
// fs/* (requests: agent → client)
//
// Slice 3 (gap #26): the agent delegates filesystem ops to the editor so the
// client can enforce trust + show the user what's being touched. Paths are
// workspace-relative; behavior on absolute paths is implementation-defined
// (most clients reject them).
// ---------------------------------------------------------------------------

export interface FsReadTextFileParams {
  sessionId: string;
  path: string;
  /** Optional offset/length window — implementations may ignore. */
  line?: number;
  limit?: number;
}

export interface FsReadTextFileResult {
  /** Full file contents (or window when line/limit applied). */
  content: string;
}

export interface FsWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

/**
 * Empty-object result shape — ACP success envelopes that carry no payload.
 * Reusable so the three empty-result types (`FsWriteTextFileResult`,
 * `TerminalKillResult`, `TerminalReleaseResult`) share one definition rather
 * than re-declaring the `[key: string]: never` index pattern (verifier LOW 2).
 */
export type EmptyAcpResult = Record<string, never>;

/** Write returns an empty object on success per ACP. */
export type FsWriteTextFileResult = EmptyAcpResult;

// ---------------------------------------------------------------------------
// terminal/* (requests: agent → client)
//
// The agent asks the client to spawn and manage a terminal. terminalId is
// opaque from the agent's side; output/wait/kill/release all reference it.
// ---------------------------------------------------------------------------

export interface TerminalCreateParams {
  sessionId: string;
  /** Argv-style command — first element is the program. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Cap on bytes the client buffers; oldest bytes drop. */
  outputByteLimit?: number;
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalOutputResult {
  /** Concatenated stdout + stderr captured so far. */
  output: string;
  /** True when the client truncated the buffer to fit outputByteLimit. */
  truncated: boolean;
  /**
   * Exit status if the process has exited; absent while running. Clients may
   * also surface a signal in addition to or instead of exitCode.
   */
  exitStatus?: { exitCode?: number; signal?: string };
}

export interface TerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalWaitForExitResult {
  exitCode?: number;
  signal?: string;
}

export interface TerminalKillParams {
  sessionId: string;
  terminalId: string;
}

export type TerminalKillResult = EmptyAcpResult;

export interface TerminalReleaseParams {
  sessionId: string;
  terminalId: string;
}

export type TerminalReleaseResult = EmptyAcpResult;
