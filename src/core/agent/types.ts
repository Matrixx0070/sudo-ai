/**
 * Type definitions for the SUDO-AI agent loop.
 * These types are shared across all agent sub-modules.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration options for a single AgentLoop run. */
export interface AgentConfig {
  /** Hard cap on tool-call iterations before the loop aborts. */
  maxIterations: number;
  /** Override the default LLM model for this run. */
  model?: string;
  /** Wall-clock timeout in ms for the entire run. 0 = no timeout. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Mutable runtime state tracked across one AgentLoop.run() call. */
export interface AgentState {
  /** ID of the session this run is attached to. */
  sessionId: string;
  /** Current tool-call iteration count. */
  iteration: number;
  /** True while the inner tool-call loop is running. */
  isProcessing: boolean;
  /** True while a compaction is in progress. */
  isCompacting: boolean;
  /** Number of tool calls currently awaiting results. */
  pendingToolCalls: number;
  /** Queue of follow-up user messages to process after the current turn. */
  followUpMessages: string[];
  /** Consecutive REPLAN decisions in this session (reset on non-REPLAN turn). */
  consecutiveReplans: number;
  /** Consecutive iterations where the model returned tool-calls instead of text.
   *  Reset when a text response is produced. Used to break runaway tool loops. */
  consecutiveToolIterations: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all events emitted by the agent loop.
 * Consumers receive these via the optional onEvent callback.
 */
export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown>; toolId: string }
  | { type: 'tool-result'; name: string; result: unknown; toolId: string;
      /**
       * Authoritative success from the tool's ToolResult.success. Additive and
       * OPTIONAL (preserves union narrowing / back-compat): `result` is still
       * the output string for the model/UI; downstream outcome sinks should
       * prefer this over re-classifying the string. Omitted by legacy emitters,
       * in which case consumers fall back to result-string classification.
       */
      success?: boolean;
      /**
       * The arguments the tool was invoked with. Additive + OPTIONAL. Lets
       * outcome sinks (ToolOutcomeLearner) record the real call args — e.g. the
       * recovery producer's prevention rule captures the working arguments
       * instead of an empty object. Populated by the real-execution emit paths;
       * omitted by pre-execution policy blocks where no execution args exist.
       */
      args?: Record<string, unknown> }
  | { type: 'stream-chunk'; chunk: string }
  | { type: 'compaction'; summary: string }
  | { type: 'error'; error: string }
  | { type: 'done' }
  /** Structured rich response — emitted alongside 'message' when block decomposition is available. */
  | { type: 'rich-response'; response: import('./content-types.js').RichResponse }
  // APPEND ONLY — do not modify existing variants above.
  | { type: 'trace-meta'; skillId?: string; skillSource?: string; skillKind?: string;
      complexity?: import('../shared/wave10-types.js').ComplexityResult;
      taint?: import('../shared/wave10-types.js').Taint };

/** Callback invoked by the agent loop for each emitted event. */
export type AgentEventHandler = (event: AgentEvent) => void;
