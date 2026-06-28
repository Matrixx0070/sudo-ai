/**
 * react-loop.ts
 *
 * ReACT (Reasoning + Acting) loop scaffolding for SUDO-AI v4.
 * Provides the system-prompt addition, observation formatting, and step
 * record creation utilities that wire into the AgentLoop.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReACTStep {
  stepNumber: number;
  thought: string;
  action: string;
  actionInput: Record<string, unknown>;
  observation: string;
  reflection: string;
  timestamp: string;
}

export interface ReACTResult {
  steps: ReACTStep[];
  finalAnswer: string;
  totalSteps: number;
  totalMs: number;
}

export interface ReACTConfig {
  /** Minimum number of tool-call steps before a final answer is allowed. Default: 3 */
  minSteps: number;
  /** Hard cap on reasoning steps. Default: 10 */
  maxSteps: number;
  /** Whether each step must include a reflection segment. Default: true */
  requireReflection: boolean;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_REACT_CONFIG: ReACTConfig = {
  minSteps: 3,
  maxSteps: 10,
  requireReflection: true,
};

// ---------------------------------------------------------------------------
// ReACTLoop class
// ---------------------------------------------------------------------------

export class ReACTLoop {
  constructor(
    private readonly config: ReACTConfig = DEFAULT_REACT_CONFIG,
  ) {
    if (config.minSteps < 1) {
      throw new RangeError(`ReACTConfig.minSteps must be ≥ 1, got ${config.minSteps}`);
    }
    if (config.maxSteps < config.minSteps) {
      throw new RangeError(`ReACTConfig.maxSteps (${config.maxSteps}) must be ≥ minSteps (${config.minSteps})`);
    }
  }

  /**
   * Returns a system-prompt addition that instructs the LLM to follow the
   * THOUGHT → ACTION → OBSERVATION → REFLECTION pattern.
   */
  getSystemPromptAddition(): string {
    return (
      `\n\n## ReACT Reasoning Pattern\n` +
      `You MUST use the THOUGHT → ACTION → OBSERVATION → REFLECTION pattern.\n` +
      `Before giving your final answer, you MUST make at least ${this.config.minSteps} tool calls.\n` +
      `For each step:\n` +
      `- THOUGHT: Explain what you need to find out and why\n` +
      `- ACTION: Call a tool with specific parameters\n` +
      `- After receiving the result, provide REFLECTION: what did you learn? what does this change?\n` +
      `Only provide FINAL ANSWER after at least ${this.config.minSteps} tool calls.`
    );
  }

  /**
   * Wraps a raw tool result in a labelled observation string for the LLM.
   */
  formatObservation(toolName: string, result: string, stepNumber: number): string {
    return `[Step ${stepNumber} Observation - ${toolName}]: ${result}`;
  }

  /**
   * Returns true when enough steps have been taken to allow a final answer.
   */
  hasMinimumSteps(stepCount: number): boolean {
    return stepCount >= this.config.minSteps;
  }

  /**
   * Returns true when the step hard cap has been reached. The outer loop must
   * check this and stop calling createStep to honour the maxSteps contract.
   */
  hasReachedMaxSteps(stepCount: number): boolean {
    return stepCount >= this.config.maxSteps;
  }

  /**
   * Creates a strongly-typed ReACTStep record (does not mutate any state).
   */
  createStep(
    stepNumber: number,
    thought: string,
    action: string,
    actionInput: Record<string, unknown>,
    observation: string,
    reflection: string,
  ): ReACTStep {
    return {
      stepNumber,
      thought,
      action,
      actionInput,
      observation,
      reflection,
      timestamp: new Date().toISOString(),
    };
  }
}
