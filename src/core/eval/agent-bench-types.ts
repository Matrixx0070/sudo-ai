/**
 * @file agent-bench-types.ts
 * @description Types for agentic benchmarks — tasks where a real SUDO AI agent
 * loop is given a workspace, uses tools (read/write/exec) to modify files, and
 * is scored by running held-out tests against the resulting workspace.
 *
 * Distinct from {@link BenchTask} (single-turn prompt → response → verifier),
 * which measures the model alone. AgentBenchTask measures the harness.
 */

import type { VerifierResult } from '../shared/wave10-types.js';

/** A workspace-based agentic benchmark task. */
export interface AgentBenchTask {
  /** Stable task identifier. */
  id: string;
  /** Human-readable task name. */
  name: string;
  /**
   * Populate the workspace directory with initial files (broken code, tests, fixtures).
   * Receives an absolute path to an empty temp dir; must place all needed files there.
   * Held-out tests should be placed alongside agent-visible files — the verifier reads
   * the SAME directory after the agent finishes.
   */
  setupWorkspace(workspaceDir: string): Promise<void>;
  /**
   * The prompt sent to the agent. {workspace} is replaced with the workspace path.
   * Should tell the agent what to fix, where the files are, and what success looks like.
   */
  prompt: string;
  /**
   * Inspect the agent's modified workspace and produce a verdict. Typically runs a
   * test harness (pytest, npm test, etc.) inside the project sandbox.
   */
  verifyWorkspace(workspaceDir: string): Promise<VerifierResult>;
  /** Max wall-clock for the agent loop, in ms. Default 120_000 (2 min). */
  timeoutMs?: number;
  /** Max tool iterations for the agent loop. Default 30. */
  maxIterations?: number;
}

/** Outcome of one AgentBenchRunner run for one task. */
export interface AgentBenchResult {
  taskId: string;
  /** Model identifier used. */
  model: string;
  /** Whether the held-out verification passed. */
  passed: boolean;
  /** Score in [0, 1] from the verifier. */
  score: number;
  /** Human-readable verifier detail (failing test, exit code, etc.). */
  detail: string;
  /** Final assistant text returned by the agent loop. */
  agentText: string;
  /** Wall-clock time for the entire run (agent + verifier), in ms. */
  wallTimeMs: number;
  /** Number of agent-loop tool-call events observed during the run. */
  toolCallCount: number;
  /** SHA-256 of the agent's final text (transcript dedup, no storage of full text). */
  transcriptHash: string;
  /** ISO-8601 timestamp at the start of the run. */
  startedAt: string;
}
