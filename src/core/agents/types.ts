/**
 * @file types.ts
 * @description Type definitions for the SUDO-AI multi-agent orchestration system.
 *
 * All types are self-contained — no project imports — to prevent circular
 * dependency issues. Runtime modules import these via `import type`.
 */

// ---------------------------------------------------------------------------
// Agent role
// ---------------------------------------------------------------------------

/** Predefined specialist role names. */
export type AgentRoleName =
  | 'architect'
  | 'coder'
  | 'researcher'
  | 'reviewer'
  | 'debugger'
  | 'tester'
  | 'business-strategist'
  | 'analyst'
  | 'writer'
  | 'personal-assistant'
  | 'legal-assistant'
  | 'marketing-agent';

/**
 * Static definition of an agent role: system prompt, tool preferences,
 * temperature, and iteration budget.
 */
export interface AgentRole {
  /** Machine identifier matching AgentRoleName. */
  name: AgentRoleName;
  /** Role-specific system prompt injected before the task. */
  systemPrompt: string;
  /** Tool names this role is expected to use most. Advisory, not enforced. */
  preferredTools: string[];
  /** LLM sampling temperature for this role. */
  temperature: number;
  /** Maximum tool-call iterations before the sub-agent aborts. */
  maxIterations: number;
}

// ---------------------------------------------------------------------------
// Spawn configuration
// ---------------------------------------------------------------------------

/** Parameters required to spawn a single sub-agent. */
export interface SpawnConfig {
  /** Which specialist role to use. */
  role: AgentRoleName;
  /** Natural-language task description. Must be self-contained. */
  task: string;
  /** Optional context from prior waves or the orchestrator. */
  context?: string;
  /** Files/directories this agent should focus on. Advisory ownership. */
  fileBoundaries?: string[];
  /** Wall-clock timeout in ms. Defaults to 5 min. */
  timeout?: number;
  /** Override LLM model for this agent. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Agent instance (runtime record)
// ---------------------------------------------------------------------------

/** Lifecycle status of a spawned agent. */
export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Runtime record tracking a spawned sub-agent from creation to completion. */
export interface AgentInstance {
  /** Unique sub-agent identifier (nanoid). */
  id: string;
  /** Role this agent was spawned with. */
  role: AgentRoleName;
  /** Task description passed at spawn time. */
  task: string;
  /** Current lifecycle status. */
  status: AgentStatus;
  /** When the agent was spawned. */
  startedAt: Date;
  /** When the agent finished (completed or failed). */
  completedAt?: Date;
  /** Final text result on success. */
  result?: string;
  /** Error message on failure. */
  error?: string;
  /** Files/directories this agent owns. */
  fileBoundaries?: string[];
}

// ---------------------------------------------------------------------------
// Inter-agent messaging
// ---------------------------------------------------------------------------

/** Category of an inter-agent message. */
export type AgentMessageType = 'context' | 'result' | 'error' | 'directive';

/** A message passed between agents or from the orchestrator. */
export interface AgentMessage {
  /** Unique message identifier (nanoid). */
  id: string;
  /** Sender agent ID or 'orchestrator'. */
  from: string;
  /** Recipient agent ID or 'all' for broadcast. */
  to: string;
  /** Message category. */
  type: AgentMessageType;
  /** Message payload (natural-language text). */
  content: string;
  /** When the message was created. */
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Wave / pipeline
// ---------------------------------------------------------------------------

/** A wave is a group of agents that run concurrently within a pipeline. */
export interface Wave {
  /** Human-readable wave label, e.g. 'design', 'build', 'review'. */
  name: string;
  /** Agents to spawn in this wave. All run in parallel. */
  agents: SpawnConfig[];
}

/** Result of a single wave execution. */
export interface WaveResult {
  /** Wave label. */
  name: string;
  /** Agent instance records for every agent in the wave. */
  agents: AgentInstance[];
  /** Wall-clock duration of the entire wave in ms. */
  durationMs: number;
}

/** Final result of a full multi-wave pipeline. */
export interface PipelineResult {
  /** Ordered list of wave results. */
  waves: WaveResult[];
  /** Total wall-clock duration across all waves in ms. */
  totalDurationMs: number;
  /** True if every agent in every wave completed successfully. */
  success: boolean;
  /** Human-readable summary of the pipeline outcome. */
  summary: string;
}
