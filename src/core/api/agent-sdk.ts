/**
 * @file agent-sdk.ts
 * @description Thin facade over internal SUDO-AI modules for external consumers.
 *
 * External integrators (plugins, third-party bots, automation scripts) should
 * depend on this facade rather than importing from deep internal paths.  This
 * keeps the public surface stable even as internal modules are refactored.
 *
 * Usage:
 * ```ts
 * const sdk = new AgentSDK({
 *   sendMessage: brain.send.bind(brain),
 *   getHistory:  brain.getHistory.bind(brain),
 *   listTools:   toolRegistry.list.bind(toolRegistry),
 * });
 *
 * const { sessionId } = await sdk.createSession('telegram', 'user123');
 * const { response }  = await sdk.sendMessage(sessionId, 'Hello!');
 * ```
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Dependency bag injected by the host application.
 * All fields except `sendMessage` are optional — the SDK degrades gracefully
 * when capabilities are not wired up.
 */
export interface AgentSDKDeps {
  /**
   * Send a message within a session and return the assistant's reply.
   *
   * @param sessionId - Opaque session identifier produced by `createSession`.
   * @param message   - User message text.
   * @returns         - The assistant's response text.
   */
  sendMessage: (sessionId: string, message: string) => Promise<string>;

  /**
   * Retrieve the ordered conversation history for a session.
   * Returns `[]` when not provided.
   *
   * @param sessionId - Session whose history to retrieve.
   */
  getHistory?: (sessionId: string) => Promise<Array<{ role: string; content: string }>>;

  /**
   * Return metadata objects for all registered tools.
   * Returns `[]` when not provided.
   */
  listTools?: () => object[];
}

// ---------------------------------------------------------------------------
// AgentSDK
// ---------------------------------------------------------------------------

/**
 * Public facade for SUDO-AI agent capabilities.
 *
 * Responsibilities:
 *  - Compose a deterministic session ID from channel + peerId + timestamp.
 *  - Delegate message dispatch to the injected `sendMessage` implementation.
 *  - Provide optional history and tool-listing access behind safe fallbacks.
 */
export class AgentSDK {
  constructor(private readonly deps: AgentSDKDeps) {}

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Create a new session for a peer on a given channel.
   *
   * The session ID encodes `channel`, `peerId`, and the creation timestamp so
   * that it is unique, human-readable, and traceable in logs.
   *
   * @param channel - Transport channel (e.g. `'telegram'`, `'web'`).
   * @param peerId  - Platform-specific peer identifier.
   * @returns       - Object containing the new `sessionId`.
   */
  async createSession(channel: string, peerId: string): Promise<{ sessionId: string }> {
    const sessionId = `${channel}:${peerId}:${Date.now()}`;
    return { sessionId };
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * Send a message within an existing session and receive the assistant reply.
   *
   * @param sessionId - Session identifier returned by `createSession`.
   * @param message   - User message text.
   * @returns         - Object containing the assistant `response` and the
   *                   echoed `sessionId` for stateless callers.
   */
  async sendMessage(
    sessionId: string,
    message: string,
  ): Promise<{ response: string; sessionId: string }> {
    const response = await this.deps.sendMessage(sessionId, message);
    return { response, sessionId };
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /**
   * Return the conversation history for a session in chronological order.
   * Each entry has a `role` (`'user'` | `'assistant'`) and `content` string.
   *
   * Returns an empty array when no `getHistory` dependency was provided.
   *
   * @param sessionId - Session whose history to retrieve.
   */
  async getHistory(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    return this.deps.getHistory?.(sessionId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  /**
   * Return metadata for all tools registered with the agent.
   * Returns an empty array when no `listTools` dependency was provided.
   */
  listTools(): object[] {
    return this.deps.listTools?.() ?? [];
  }
}
