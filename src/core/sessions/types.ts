/**
 * @file types.ts
 * @description Type definitions for the SUDO-AI sessions module.
 *
 * A Session tracks all messages exchanged with a specific peer on a specific
 * channel. The brain module attaches to a Session to maintain conversation
 * continuity across multiple messages.
 */

import type { ChannelType } from '../channels/types.js';

// ---------------------------------------------------------------------------
// Brain message (minimal interface — decoupled from brain module)
// ---------------------------------------------------------------------------

/**
 * A single message in the conversation history passed to the LLM.
 * Intentionally minimal to avoid circular imports with the brain module;
 * the brain module should extend or assert-cast as needed.
 */
export interface BrainMessage {
  /** Message role as understood by LLM APIs. */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Text content of the message. */
  content: string;
  /** Tool name, populated when role === 'tool'. */
  toolName?: string;
  /** Tool call input JSON string, populated when role === 'tool'. */
  toolInput?: string;
  /** Tool call output JSON string, populated when role === 'tool'. */
  toolOutput?: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Session lifecycle state. */
export type SessionState = 'active' | 'compacted' | 'archived';

/**
 * A conversation session between SUDO-AI and a single peer on a single channel.
 * Persisted to MindDB and loaded on demand.
 */
export interface Session {
  /** Unique session identifier (nanoid). */
  id: string;
  /** Which channel this session belongs to. */
  channel: ChannelType;
  /** Platform-specific peer identifier (user ID, JID, channel ID). */
  peerId: string;
  /** Current lifecycle state. */
  state: SessionState;
  /** Model ID that was last used for this session (optional). */
  model?: string;
  /** In-memory message history for this session (not fully persisted inline). */
  messages: BrainMessage[];
  /** When this session was first created. */
  createdAt: Date;
  /** When this session was last modified. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Routing target
// ---------------------------------------------------------------------------

/**
 * Whether the brain should process a message in the main (persistent) session
 * or in a sandboxed, isolated session (used for tool evaluation / safety runs).
 */
export type SessionTarget = 'main' | 'isolated';
