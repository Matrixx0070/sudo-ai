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

// ---------------------------------------------------------------------------
// AgentRunResult — returned by run() so callers can receive file attachments
// ---------------------------------------------------------------------------

/**
 * Structured return value from AgentLoop.run().
 * Contains the final text response plus any file attachments produced during
 * the turn (e.g. screenshots, generated images, exported documents).
 */
export interface AgentRunResult {
  /** Final assistant text response. */
  text: string;
  /** File attachments produced during the turn (screenshots, images, etc.). */
  attachments: Array<{
    type: 'image' | 'video' | 'audio' | 'document';
    path: string;
    filename?: string;
  }>;
  /** P0: SelfVerify — post-run verification summary if SUDO_SELF_VERIFY is enabled. */
  verificationSummary?: string;
  /** Theme 2.2: reasoning recap (approach/steps/confidence) if SUDO_REASONING_SUMMARY is enabled. */
  reasoningSummary?: string;
  /**
   * Theme 2 step-tracking: APPROXIMATE coverage of the auto-plan's steps by this
   * turn's tool actions (present only when SUDO_AUTO_PLAN produced a plan).
   * `unaddressed` is a soft anti-"phantom-completion" signal, not a hard verdict.
   */
  planProgress?: { totalSteps: number; addressedCount: number; unaddressed: string[] };
  /**
   * Heuristic phantom-completion check of the final response (placeholder /
   * truncation / length / request cross-reference). Present only when
   * SUDO_COMPLETION_VERIFY=1. Observable-only — never alters the response.
   */
  completionVerification?: { passed: boolean; confidence: number; failedChecks: string[] };
  /**
   * True when this run performed an external, user-visible side effect (sent a
   * message, posted to a channel, spawned a sub-agent, created a cron job). A
   * caller that re-runs turns (the task executor's auto-retry) must NOT blindly
   * re-dispatch a run that committed outbound — it would re-fire the side effect.
   * See {@link markCommittedOutbound} / TaskQueue.markCommittedOutbound.
   */
  committedOutbound?: boolean;
}
