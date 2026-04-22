/**
 * @file types.ts
 * @description Type declarations for the procedural-memory subsystem.
 *
 * Procedures are compiled from observed repeated tool-call sequences.
 * They represent learned "how-to" knowledge the AI can replay automatically.
 *
 * No logic, no imports — pure type declarations only.
 */

// ---------------------------------------------------------------------------
// ProcedureStep
// ---------------------------------------------------------------------------

/**
 * A single step within a compiled procedure.
 * Maps one tool invocation to its expected role in the sequence.
 */
export interface ProcedureStep {
  /** Fully-qualified tool name, e.g. "coder.read-file". */
  toolName: string;
  /**
   * Template of arguments to pass when replaying this step.
   * Keys are argument names; values are literal defaults or placeholder strings.
   * Empty object means arguments must be supplied at replay time.
   */
  argumentTemplate: Record<string, unknown>;
  /** Natural-language description of what this step should produce. */
  expectedOutcome: string;
  /** Zero-based position of this step within the procedure (0 = first). */
  order: number;
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

/**
 * A compiled, reusable procedure derived from repeated tool-call patterns.
 * Stored in the `procedures` table.
 */
export interface Procedure {
  /** Unique identifier (nanoid). */
  id: string;
  /** Human-readable name. Auto-generated names begin with "auto_". */
  name: string;
  /** Optional description of what the procedure accomplishes. */
  description: string;
  /**
   * Pattern string used to match this procedure against incoming context.
   * Stored as a LIKE-compatible substring: "tool_a then tool_b then tool_c".
   */
  triggerPattern: string;
  /** Ordered list of steps that make up this procedure. */
  steps: ProcedureStep[];
  /** Number of times this procedure was executed successfully. */
  successCount: number;
  /** Number of times this procedure failed during execution. */
  failureCount: number;
  /** Rolling average wall-clock duration of successful executions in ms. */
  avgDurationMs: number;
  /** ISO-8601 timestamp of the most recent execution, or null if never run. */
  lastUsed: string | null;
  /** Session IDs from which this procedure was compiled. */
  compiledFrom: string[];
  /** When false the procedure is suppressed from matching. */
  enabled: boolean;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// ToolCallRecord
// ---------------------------------------------------------------------------

/**
 * A record of a single tool invocation within a session.
 * Passed to the detector to build up sequence observations.
 */
export interface ToolCallRecord {
  /** Fully-qualified tool name, e.g. "coder.read-file". */
  toolName: string;
  /** Arguments supplied to the tool. */
  arguments: Record<string, unknown>;
  /** Serialised result returned by the tool. */
  result: string;
  /** Wall-clock duration of this tool call in milliseconds. */
  durationMs: number;
}
