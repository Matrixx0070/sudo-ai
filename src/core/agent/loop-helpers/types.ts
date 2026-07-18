/**
 * F103 loop-helpers decomposition — shared duck-typed interfaces.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import type { AgentEvent } from '../types.js';
import type { ToolSchema } from '../../tools/types.js';

// ---------------------------------------------------------------------------
// Shared duck-typed interfaces (mirrors loop.ts — kept in sync manually)
// ---------------------------------------------------------------------------

export interface BrainMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  /** Name of the tool that produced this result (present when role === 'tool'). */
  toolName?: string;
  /** Internal marker: already written to the DB (set by SessionManager). Non-LLM. */
  _persisted?: boolean;
  /**
   * Internal marker: an ephemeral, per-turn system block (intelligence brief,
   * deep insights, drive prompt, tier adjustment, commitments, injection
   * warning) re-generated from live state each turn. Persistence skips these so
   * the DB holds only real conversation. Non-LLM. See SUDO_PERSIST_EPHEMERAL.
   */
  _ephemeral?: boolean;
  /** Internal marker: durable system message that must survive a cold reload
   * (the fork handoff notice). System messages are ephemeral unless flagged. */
  _durable?: boolean;
}

export interface BrainRequest {
  messages: BrainMessage[];
  model?: string;
  tools?: ToolSchema[];
  race?: boolean;
  source?: string;
  /** gw-cutover Phase 2: session→trace correlation for IR-served calls. */
  sessionId?: string;
}

export interface BrainResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error';
  model: string;
  /** Token usage reported by the provider (optional — not all paths populate this). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  /**
   * Resolved sampling params actually used (temperature + max output tokens;
   * `seed` only when pinned). Surfaced by Brain for deterministic replay capture
   * — see the brain-call recording in loop.ts. Optional: not all return paths
   * (e.g. negative-router blocks) populate it.
   */
  sampling?: { temperature: number; maxTokens: number; seed?: number };
}

export interface ToolContext {
  sessionId: string;
  workingDir: string;
  config: unknown;
  logger: unknown;
  /** Abort signal forwarded from the registry's timeout controller. */
  signal?: AbortSignal;
  /**
   * Sandbox policy for the session. When enabled, shell-exec routes through bwrap.
   * Type-only inline import — erased at compile time; safe before sandbox-types.ts exists.
   */
  sandboxPolicy?: import('../../sandbox/sandbox-types.js').SandboxPolicy;
  /**
   * Absolute path to the provisioned per-session workspace directory.
   * Falls back to workingDir when sandboxManager is absent.
   */
  workspaceDir?: string;
}

export interface BrainLike {
  /**
   * @param opts Optional per-call overrides. `strategy` lets a caller escalate a
   * single call to a stronger multi-model strategy (swarm-rescue) without
   * mutating the brain's global strategy. Structurally matches the real
   * Brain.call(request, BrainCallOpts); inlined to avoid coupling loop-helpers
   * to the brain module. A 1-arg duck-typed mock still satisfies this.
   */
  call(
    req: BrainRequest,
    opts?: {
      strategy?: 'single' | 'debate' | 'tree-search';
      tier?: 'fast' | 'routine' | 'high-stakes';
    },
  ): Promise<BrainResponse>;
  /**
   * Optional chat-style entry point. Real Brain class has it (returns the
   * raw assistant text); duck-typed mocks may not. Callers must guard.
   */
  chat?(
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>,
    model?: string,
  ): Promise<string>;
}

/** Minimal tool descriptor shape used by the smart tool router. */
export interface ToolDescriptor {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
  /** Declared safety level — 'destructive' tools never run in parallel. */
  safety?: 'readonly' | 'destructive';
  /** Confirmation-gated tools never run in parallel. */
  requiresConfirmation?: boolean;
}

export interface ToolRegistryLike {
  execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<{ success: boolean; output: string }>;
  getSchemaForLLM(): ToolSchema[];
  /** Return whether a tool requires user confirmation before execution. */
  requiresConfirmation?(name: string): boolean;
  /**
   * Register a tool. Optional because some test/mock registries that
   * implement only the read-side surface don't need to accept new tools.
   * Real ToolRegistry instances always supply this.
   */
  register?(toolDef: unknown): void;
  // ---- Optional methods consumed by ToolRouter (smart routing) ----
  /** Return all enabled tools whose category matches the given string. */
  getByCategory?(category: string): ToolDescriptor[];
  /** Return every currently-enabled tool as slim descriptors. */
  listEnabled?(): ToolDescriptor[];
  /** Look up a single tool descriptor by name. */
  get?(name: string): ToolDescriptor | undefined;
  /** Return true if the named tool is registered and enabled. */
  isEnabled?(name: string): boolean;
}

export interface SessionLike {
  id: string;
  messages: BrainMessage[];
  /** Originating channel for approval routing (e.g. "telegram"). */
  channel?: string;
  /** Originating peer/user ID for approval routing. */
  peerId?: string;
  /**
   * Ad-hoc session metadata stored by the agent loop for next-turn priming
   * (e.g. _feedbackTierAdjustment, _consciousnessEndContext). Keyed loosely
   * because these fields are written/read dynamically and are not persisted
   * inline. `unknown` keeps reads type-safe (callers must narrow).
   */
  [key: string]: unknown;
}

export type Emitter = (event: AgentEvent) => void;

// ---------------------------------------------------------------------------
// HookEmitterLike — duck-typed (mirrors loop.ts declaration)
// ---------------------------------------------------------------------------

/**
 * Minimal hook-emission interface threaded into helpers to avoid circular imports.
 * Mirrors the declaration in loop.ts.
 */
export interface HookEmitterLike {
  emit(event: string, context: Record<string, unknown>): Promise<void>;
}

/**
 * Minimal contract the AgentLoop consumes from a verify-gate implementation.
 * Mirrors `ConfidenceGate.evaluate()` from verify-gate.ts so the helper does
 * not need to import the concrete class (keeps loop-helpers free of DB deps).
 */
export interface VerifyGateLike {
  evaluate(toolName: string): {
    decision: 'allow' | 'escalate' | 'unknown';
    confidence: number | null;
    threshold: number;
    samples: number;
    reason: string;
  };
}

/**
 * Minimal contract the AgentLoop consumes from a grounding-checker implementation
 * (slice 2 of the verify-gate campaign). Mirrors `GroundingChecker.check()` from
 * verify-gate-grounding.ts so this helper stays free of fs/Promise deps in its
 * type surface — concrete class is constructed in loop.ts.
 */
export interface GroundingCheckerLike {
  check(toolName: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    reason: string;
    checked?: 'edit-grounding' | 'file-reference-grounding';
    evidence?: Record<string, unknown>;
  }>;
}

/**
 * Minimal contract the AgentLoop consumes from a critic-pass implementation
 * (slice 3 of the verify-gate campaign). Mirrors `CriticPass.review()` from
 * verify-gate-critic.ts. Slice 3 is observable-only: the verdict ships out as
 * a hook event but does NOT block execution. Trigger 'grounding-failed' fires
 * an LLM critic call; 'low-confidence' short-circuits to a soft-skip.
 */
export interface CriticPassLike {
  review(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    trigger: 'grounding-failed' | 'low-confidence';
    confidence: number | null;
    threshold: number;
    evidence?: Record<string, unknown>;
  }): Promise<{
    invoked: boolean;
    verdict: 'approve' | 'reject' | 'skip';
    reason: string;
    rationale?: string;
    /** Critic's self-assessed 0-100 certainty in its verdict (observable-only). */
    confidence?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Duck-typed SecurityGuard interface (avoids circular imports)
// ---------------------------------------------------------------------------

export interface SecurityGuardLike {
  validateToolCall(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason?: string };
  logSecurityEvent(event: {
    type: string;
    userId: string;
    details: string;
    severity: string;
    timestamp: string;
  }): void;
  /** Optional prompt-injection check. Not all guard implementations carry it. */
  detectInjection?(message: string): { safe: boolean; threat: string | null; score: number };
}

// ---------------------------------------------------------------------------
// SandboxManagerLike — duck-typed to avoid circular imports
// ---------------------------------------------------------------------------

/**
 * Minimal interface that loop-helpers needs from SandboxManager.
 * Avoids importing the concrete class from Builder A's files directly.
 * The real SandboxManager must implement at minimum these methods.
 */
export interface SandboxManagerLike {
  /** Provision workspace directory for sessionId, returns absolute path. */
  provision(sessionId: string): Promise<string>;
  /** Return the provisioned workspace directory for the given sessionId. */
  getWorkspaceDir(sessionId: string): string;
  /** Return the merged sandbox policy for the given sessionId. */
  getPolicyFor(sessionId: string): import('../../sandbox/sandbox-types.js').SandboxPolicy;
}

// ---------------------------------------------------------------------------
// Phase 2 polish: duck-typed Likes for injected FeedbackMemory
// (defined here to keep loop-helpers self-contained; mirrors other *Like patterns above)
// ---------------------------------------------------------------------------

export interface FeedbackMemoryLike {
  /** Matches real FeedbackMemory.recordSuccess(toolName, input, outcome, score?, sessionId?) */
  recordSuccess(
    toolName: string,
    input: unknown,
    outcome: string,
    score?: number,
    sessionId?: string,
  ): unknown;
  /** Matches real FeedbackMemory.recordFailure(toolName, input, error, sessionId?) */
  recordFailure(
    toolName: string,
    input: unknown,
    error: string,
    sessionId?: string,
  ): unknown;
}
