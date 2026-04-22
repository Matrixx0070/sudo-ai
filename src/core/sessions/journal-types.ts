/**
 * @file journal-types.ts
 * @description JSONL journal record types and session index types for the
 * SUDO-AI append-only session journal system.
 *
 * Every event written to a .jsonl file conforms to one of the JournalEvent
 * union members. The sessions.json index tracks all known sessions so the
 * store can locate files without scanning the filesystem.
 */

// ---------------------------------------------------------------------------
// Base event
// ---------------------------------------------------------------------------

/** Fields shared by every journal event. */
export interface JournalEventBase {
  /** ISO 8601 timestamp (e.g. "2026-04-11T12:00:00.000Z"). */
  readonly ts: string;
  /** nanoid — matches the Session.id this event belongs to. */
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Concrete event types
// ---------------------------------------------------------------------------

/** Written once when a session is first created. */
export interface JournalSessionCreated extends JournalEventBase {
  type: 'session';
  /** Channel type (telegram, discord, …). */
  channel: string;
  /** Platform-specific peer identifier. */
  peerId: string;
  /** Optional model in use at session creation time. */
  model?: string;
}

/** Written when the active LLM model changes mid-session. */
export interface JournalModelChanged extends JournalEventBase {
  type: 'model_change';
  /** Previous model, or undefined when no model was set. */
  from: string | undefined;
  /** New model. */
  to: string;
}

/** Written for every user/assistant/system/tool message. */
export interface JournalMessage extends JournalEventBase {
  type: 'message';
  /** Message role. */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Text content of the message. */
  content: string;
  /** Populated when role === 'tool'. */
  toolName?: string;
  /** Populated when role === 'tool'. */
  toolCallId?: string;
}

/** Written when a tool call returns its result. */
export interface JournalToolResult extends JournalEventBase {
  type: 'toolResult';
  /** Correlates with the originating tool call. */
  toolCallId: string;
  /** Name of the tool that was called. */
  toolName: string;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Serialised output (JSON string or plain text). */
  output: string;
}

/** Discriminated union of all journal event types. */
export type JournalEvent =
  | JournalSessionCreated
  | JournalModelChanged
  | JournalMessage
  | JournalToolResult;

// ---------------------------------------------------------------------------
// Session index
// ---------------------------------------------------------------------------

/** One entry in the sessions.json index file. */
export interface SessionIndexEntry {
  /** Session nanoid — matches Session.id. */
  id: string;
  /** Channel type string. */
  channel: string;
  /** Platform-specific peer identifier. */
  peerId: string;
  /**
   * 12-hex-char SHA-256 digest of "{channel}:{peerId}".
   * Used as the sub-directory name under the base sessions directory.
   */
  agentId: string;
  /** Relative path from base dir to the .jsonl file (e.g. "abc123/uuid.jsonl"). */
  file: string;
  /** ISO 8601 — when the session was created. */
  createdAt: string;
  /** ISO 8601 — when the session was last written to. */
  updatedAt: string;
  /** Current lifecycle state. */
  state: 'active' | 'archived';
}

/** Top-level shape of sessions.json. */
export interface SessionIndex {
  version: 1;
  entries: SessionIndexEntry[];
}
