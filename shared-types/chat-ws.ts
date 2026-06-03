/**
 * WebSocket message types for SUDO-AI v4 chat channel.
 * Pure type definitions - no runtime code.
 *
 * Based on web.ts message handling (lines 178-192):
 * - Server sends: thinking, progress, user_echo, reply (raw text or JSON)
 * - Client sends: raw text message
 */

// ---------------------------------------------------------------------------
// Server -> Client Messages
// ---------------------------------------------------------------------------

/**
 * Thinking update - sent while AI is processing.
 * Displayed as "Thinking..." animation in UI.
 */
export type ThinkingMessage = {
  type: 'thinking';
  /** Text to display (default: "Thinking..."). */
  text?: string;
};

/**
 * Progress update - sent during long-running operations.
 * Displayed as "Thinking..." with updated text.
 */
export type ProgressMessage = {
  type: 'progress';
  /** Progress text to display. */
  text: string;
};

/**
 * User echo - echoes back the user's message for display.
 * Sent when message arrives via POST /api/message.
 */
export type UserEchoMessage = {
  type: 'user_echo';
  /** The original user message text. */
  text: string;
};

/**
 * Final reply - the AI's response.
 * May be raw text or JSON-serialized structured response.
 */
export type ReplyMessage = {
  type: 'reply';
  /** Response content (text or serialized JSON). */
  content: string;
};

/**
 * Error message - sent when an error occurs.
 */
export type ErrorMessage = {
  type: 'error';
  /** Error message text. */
  error: string;
};

/**
 * Union of all server-to-client WebSocket message types.
 */
export type ChatWSReceiveMessage =
  | ThinkingMessage
  | ProgressMessage
  | UserEchoMessage
  | ReplyMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Client -> Server Messages
// ---------------------------------------------------------------------------

/**
 * Client send message - raw text sent over WebSocket.
 * The web.ts adapter receives raw text (not JSON) and dispatches to handler.
 *
 * Note: The browser client (web.ts line 210) sends raw text via ws.send(t).
 * JSON parsing happens server-side in the agent loop.
 */
export type ChatWSSendMessage = {
  /** Plain text message content. */
  text: string;
  /** Optional peerId for targeted delivery (set via ?peer= query param). */
  peerId?: string;
  /** Optional auth token (alternatively sent via ?token= query param). */
  token?: string;
};

// ---------------------------------------------------------------------------
// WebSocket Connection Options
// ---------------------------------------------------------------------------

/**
 * Options for establishing a WebSocket connection.
 */
export type ChatWSOptions = {
  /** Auth token (alternatively sent via ?token= query param). */
  token?: string;
  /** Fixed peerId for targeted delivery (set via ?peer= query param). */
  peerId?: string;
};

// ---------------------------------------------------------------------------
// Utility Types
// ---------------------------------------------------------------------------

/**
 * Type guard to check if a received message is a thinking message.
 */
export function isThinkingMessage(msg: unknown): msg is ThinkingMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'thinking'
  );
}

/**
 * Type guard to check if a received message is a progress message.
 */
export function isProgressMessage(msg: unknown): msg is ProgressMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'progress'
  );
}

/**
 * Type guard to check if a received message is a user echo message.
 */
export function isUserEchoMessage(msg: unknown): msg is UserEchoMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'user_echo'
  );
}

/**
 * Type guard to check if a received message is a reply message.
 */
export function isReplyMessage(msg: unknown): msg is ReplyMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'reply'
  );
}

/**
 * Type guard to check if a received message is an error message.
 */
export function isErrorMessage(msg: unknown): msg is ErrorMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'error'
  );
}
