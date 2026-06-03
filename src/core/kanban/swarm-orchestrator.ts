/**
 * @file swarm-orchestrator.ts
 * @description SwarmOrchestrator — decomposes tasks and manages parallel worker execution.
 *
 * Uses the blackboard pattern: workers write structured JSON results to a shared
 * space that the synthesizer reads to produce a final merged result.
 *
 * Kill-switch: SUDO_KANBAN_DISABLE=1 disables all operations.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { pushCompletionBus } from '../agent/push-completion.js';
import type { KanbanTask, SwarmWorkerSpec, SwarmResult, SwarmStatus } from './kanban-types.js';
import { kanbanBoard } from './kanban-board.js';

const log = createLogger('kanban:swarm-orchestrator');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KILL_SWITCH = 'SUDO_KANBAN_DISABLE';
const DEFAULT_MAX_RUNTIME = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDisabled(): boolean {
  return process.env[KILL_SWITCH] === '1';
}

/**
 * Decompose a task into worker specs based on skills required.
 * Each skill becomes a separate worker assignment.
 */
function decomposeTask(task: KanbanTask): SwarmWorkerSpec[] {
  if (task.skills.length === 0) {
    // No skills specified — create a single general worker
    return [{
      profile: 'sonnet',
      title: `Complete: ${task.title}`,
      body: task.body,
      skills: ['general'],
      priority: task.priority,
      maxRuntimeSeconds: DEFAULT_MAX_RUNTIME,
    }];
  }

  // Create one worker per skill
  return task.skills.map((skill, index) => ({
    profile: 'sonnet',
    title: `${skill}: ${task.title}`,
    body: `${task.body}\n\nFocus area: ${skill}\nThis is worker ${index + 1} of ${task.skills.length}.`,
    skills: [skill],
    priority: task.priority,
    maxRuntimeSeconds: DEFAULT_MAX_RUNTIME,
  }));
}

// ---------------------------------------------------------------------------
// SwarmOrchestrator class
// ---------------------------------------------------------------------------

export class SwarmOrchestrator {
  private readonly swarms = new Map<string, SwarmResult>();

  /**
   * Decompose a task into worker specifications.
   * Each skill in the task becomes a separate worker.
   */
  decompose(task: KanbanTask): SwarmWorkerSpec[] {
    if (isDisabled()) {
      throw new Error('SwarmOrchestrator: SUDO_KANBAN_DISABLE=1');
    }
    return decomposeTask(task);
  }

  /**
   * Spawn a swarm of workers to execute in parallel.
   * Uses push-completion bus for async result collection.
   *
   * Note: This is a stub implementation that tracks swarm state.
   * Actual agent spawning requires AgentLoop injection.
   */
  async spawnSwarm(specs: SwarmWorkerSpec[], rootTaskId: string): Promise<SwarmResult> {
    if (isDisabled()) {
      throw new Error('SwarmOrchestrator: SUDO_KANBAN_DISABLE=1');
    }

    const swarmId = genId();
    const workerIds = specs.map(() => genId());

    const result: SwarmResult = {
      rootId: rootTaskId,
      swarmId,
      workerIds,
      verifierId: null,
      synthesizerId: null,
      status: 'running',
      results: new Map(),
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    this.swarms.set(swarmId, result);
    log.info({ swarmId, workerCount: workerIds.length, rootTaskId }, 'Swarm spawned');

    // Subscribe to completion events for each worker
    for (const workerId of workerIds) {
      pushCompletionBus.subscribe(rootTaskId, workerId);
    }

    // Set up listener to collect results
    const listener = (event: { agentId: string; result?: string; error?: string }) => {
      const swarm = this.swarms.get(swarmId);
      if (!swarm) return;

      const index = swarm.workerIds.indexOf(event.agentId);
      if (index === -1) return;

      if (event.result !== undefined) {
        swarm.results.set(event.agentId, event.result);
        log.debug({ swarmId, workerId: event.agentId, resultLen: event.result.length }, 'Worker result collected');
      } else if (event.error !== undefined) {
        swarm.results.set(event.agentId, `ERROR: ${event.error}`);
        log.warn({ swarmId, workerId: event.agentId, error: event.error }, 'Worker failed');
      }

      // Check if all workers completed
      if (swarm.results.size >= swarm.workerIds.length) {
        swarm.status = 'completed';
        swarm.completedAt = new Date().toISOString();
        log.info({ swarmId, resultCount: swarm.results.size }, 'Swarm completed');
      }
    };

    pushCompletionBus.on('subagent:complete', listener);
    pushCompletionBus.on('subagent:failed', listener);

    // Store cleanup handler
    (result as unknown as { _cleanup?: () => void })._cleanup = () => {
      pushCompletionBus.off('subagent:complete', listener);
      pushCompletionBus.off('subagent:failed', listener);
    };

    return result;
  }

  /**
   * Verify the results of a swarm execution.
   * Returns true if results pass verification.
   *
   * Note: This is a stub — actual verification would spawn a verifier agent.
   */
  async verifyResults(swarmId: string): Promise<boolean> {
    if (isDisabled()) {
      throw new Error('SwarmOrchestrator: SUDO_KANBAN_DISABLE=1');
    }

    const swarm = this.swarms.get(swarmId);
    if (!swarm) {
      log.warn({ swarmId }, 'verifyResults: swarm not found');
      return false;
    }

    if (swarm.status !== 'completed') {
      log.warn({ swarmId, status: swarm.status }, 'verifyResults: swarm not completed');
      return false;
    }

    // Stub verification: check that all workers produced results
    const allResults = [...swarm.results.values()];
    const hasErrors = allResults.some(r => r.startsWith('ERROR:'));

    if (hasErrors) {
      log.warn({ swarmId, errorCount: allResults.filter(r => r.startsWith('ERROR:')).length }, 'Verification found errors');
      return false;
    }

    log.info({ swarmId }, 'Verification passed');
    return true;
  }

  /**
   * Synthesize worker results into a final merged output.
   *
   * Note: This is a stub — actual synthesis would spawn a synthesizer agent.
   */
  async synthesize(swarmId: string): Promise<string> {
    if (isDisabled()) {
      throw new Error('SwarmOrchestrator: SUDO_KANBAN_DISABLE=1');
    }

    const swarm = this.swarms.get(swarmId);
    if (!swarm) {
      throw new Error(`SwarmOrchestrator: swarm ${swarmId} not found`);
    }

    if (swarm.status !== 'completed') {
      throw new Error(`SwarmOrchestrator: swarm ${swarmId} not completed`);
    }

    // Stub synthesis: concatenate all results
    const parts: string[] = [];
    for (const [workerId, result] of swarm.results.entries()) {
      if (!result.startsWith('ERROR:')) {
        parts.push(`[${workerId.slice(0, 8)}]: ${result}`);
      }
    }

    const synthesized = parts.join('\n\n---\n\n');
    log.info({ swarmId, partCount: parts.length, totalLen: synthesized.length }, 'Synthesis complete');

    return synthesized;
  }

  /**
   * Get the current state of a swarm.
   */
  getSwarm(swarmId: string): SwarmResult | undefined {
    return this.swarms.get(swarmId);
  }

  /**
   * Get all active swarms.
   */
  getActiveSwarms(): SwarmResult[] {
    return [...this.swarms.values()].filter(s => s.status === 'running' || s.status === 'pending');
  }

  /**
   * Clean up a swarm's resources.
   */
  cleanupSwarm(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (swarm) {
      const cleanup = (swarm as unknown as { _cleanup?: () => void })._cleanup;
      if (cleanup) cleanup();
      this.swarms.delete(swarmId);
      log.info({ swarmId }, 'Swarm cleaned up');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * Global singleton instance of SwarmOrchestrator.
 */
export const swarmOrchestrator = new SwarmOrchestrator();
