/**
 * @file types.ts
 * @description Core type definitions for the SUDO-AI slash command system.
 */

// ---------------------------------------------------------------------------
// Slash command interface
// ---------------------------------------------------------------------------

/**
 * A single slash command that can be registered and dispatched by the
 * CommandRegistry. Each command receives a free-form args string and a
 * CommandContext providing access to all runtime services.
 */
export interface SlashCommand {
  /** Command name without the leading slash, e.g. 'status', 'produce'. */
  name: string;
  /** One-line description shown in /help output. */
  description: string;
  /** Full usage example shown in /help, e.g. '/produce [topic]'. */
  usage: string;
  /**
   * Execute the command.
   *
   * @param args - Everything after the command name, trimmed.
   * @param ctx  - Runtime context providing access to agent services.
   * @returns A plain-text string to send back to the user.
   */
  execute(args: string, ctx: CommandContext): Promise<string>;
}

// ---------------------------------------------------------------------------
// Command execution context
// ---------------------------------------------------------------------------

/**
 * All runtime services available to a SlashCommand during execution.
 * Dependencies are typed as `unknown` to avoid circular imports; commands
 * cast to the concrete type they need.
 */
export interface CommandContext {
  /** Channel the command arrived from (e.g. 'telegram'). */
  channel: string;
  /** Platform peer identifier of the sender. */
  peerId: string;
  /** Active session ID for the sender. */
  sessionId: string;
  /** The AgentLoop instance (cast to AgentLoop in commands that need it). */
  agentLoop: unknown;
  /** The ToolRegistry instance. */
  toolRegistry: unknown;
  /** Full application config (cast to SudoConfig as needed). */
  config: unknown;
  /** Open MindDB / database handle. */
  db: unknown;
  /** Per-peer turn queue (KeyedAsyncQueue) for /queue inspection. Optional. */
  peerQueue?: unknown;
}
