/**
 * @file spawner.ts
 * @description AgentSpawner — creates role-aware sub-agents via the existing AgentSwarm.
 *
 * Wraps AgentSwarm to inject role-specific system prompts, file boundaries,
 * and context into each sub-agent's task description. Tracks all spawned
 * agents as AgentInstance records for pipeline inspection.
 */

import { createLogger } from '../shared/index.js';
import { genId } from '../shared/index.js';
import { PipelineError } from '../shared/index.js';
import { AgentSwarm } from '../agent/swarm.js';
import type { SwarmSnapshot } from '../agent/swarm.js';
import { getRole } from './roles.js';
import type { AgentInstance, SpawnConfig, AgentRole } from './types.js';

const log = createLogger('agents:spawner');

// ---------------------------------------------------------------------------
// AgentSpawner
// ---------------------------------------------------------------------------

/**
 * Creates and tracks role-aware sub-agents. Each sub-agent gets a
 * specialised system prompt assembled from its role definition, file
 * boundaries, and inter-agent context.
 *
 * Dependencies are duck-typed to match the patterns in AgentSwarm and
 * AgentLoop, avoiding circular imports.
 */
export class AgentSpawner {
  private readonly swarm: AgentSwarm;
  private readonly instances = new Map<string, AgentInstance>();

  /**
   * @param brain          - Brain instance (duck-typed: must have call()).
   * @param toolRegistry   - ToolRegistry instance (duck-typed: must have execute()).
   * @param sessionManager - SessionManager instance (duck-typed: must have get/save).
   */
  constructor(
    brain: unknown,
    toolRegistry: unknown,
    sessionManager: unknown,
  ) {
    this.swarm = new AgentSwarm(brain, toolRegistry, sessionManager);
    log.info('AgentSpawner initialized');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn a single sub-agent with a role-specific system prompt.
   *
   * The role's system prompt, file boundaries, and any prior context are
   * prepended to the task so the sub-agent receives full instructions in a
   * single message (sub-agents do not share conversation history).
   *
   * @param config - Spawn configuration.
   * @returns AgentInstance record with the final result or error.
   */
  async spawn(config: SpawnConfig): Promise<AgentInstance> {
    if (!config.task || typeof config.task !== 'string') {
      throw new PipelineError(
        'AgentSpawner.spawn: task must be a non-empty string',
        'pipeline_invalid_args',
      );
    }

    const role = getRole(config.role);
    const id = genId();

    const instance: AgentInstance = {
      id,
      role: config.role,
      task: config.task,
      status: 'pending',
      startedAt: new Date(),
      fileBoundaries: config.fileBoundaries,
    };

    this.instances.set(id, instance);
    log.info({ id, role: config.role, taskPreview: config.task.slice(0, 100) }, 'Spawning agent');

    const prompt = this._buildPrompt(role, config);

    instance.status = 'running';

    try {
      const result = await this.swarm.spawn(prompt, {
        model: config.model,
        timeout: config.timeout,
        ...(config.forkHistory ? { forkHistory: config.forkHistory } : {}),
        ...(config.resumeFromAgentId ? { resumeFromAgentId: config.resumeFromAgentId } : {}),
      });

      instance.status = 'completed';
      instance.completedAt = new Date();
      instance.result = result;

      log.info(
        { id, role: config.role, durationMs: instance.completedAt.getTime() - instance.startedAt.getTime() },
        'Agent completed',
      );

      return { ...instance };
    } catch (err) {
      instance.status = 'failed';
      instance.completedAt = new Date();
      instance.error = String(err);

      log.error({ id, role: config.role, err }, 'Agent failed');

      return { ...instance };
    }
  }

  /**
   * Return a snapshot of all tracked agent instances.
   *
   * @returns Array of AgentInstance records (copies, not references).
   */
  getInstances(): AgentInstance[] {
    return [...this.instances.values()].map((inst) => ({ ...inst }));
  }

  /**
   * Get a single agent instance by ID.
   *
   * @param agentId - The agent's unique ID.
   * @returns AgentInstance or undefined.
   */
  getInstance(agentId: string): AgentInstance | undefined {
    const inst = this.instances.get(agentId);
    return inst ? { ...inst } : undefined;
  }

  /**
   * Cancel a running sub-agent by killing it in the swarm.
   *
   * @param agentId - The agent ID to cancel.
   */
  cancel(agentId: string): void {
    this.swarm.kill(agentId);
    const inst = this.instances.get(agentId);
    if (inst && inst.status === 'running') {
      inst.status = 'failed';
      inst.completedAt = new Date();
      inst.error = 'Cancelled by spawner';
      log.info({ agentId }, 'Agent cancelled');
    }
  }

  /** Cancel all running sub-agents. */
  cancelAll(): void {
    this.swarm.killAll();
    for (const inst of this.instances.values()) {
      if (inst.status === 'running' || inst.status === 'pending') {
        inst.status = 'failed';
        inst.completedAt = new Date();
        inst.error = 'Cancelled by spawner (cancelAll)';
      }
    }
    log.info('All agents cancelled');
  }

  /** Clear all instance records. Does not cancel running agents. */
  clearHistory(): void {
    this.instances.clear();
  }

  /** Number of currently running agents. */
  get activeCount(): number {
    let count = 0;
    for (const inst of this.instances.values()) {
      if (inst.status === 'running') count++;
    }
    return count;
  }

  /**
   * Read-only swarm snapshot — what the FleetView dashboard endpoint serves
   * (gap #25 slice 1). Pass-through to the underlying AgentSwarm; exposed here
   * because callers don't have direct access to the private swarm field.
   */
  getSwarmSnapshot(): SwarmSnapshot {
    return this.swarm.snapshot();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Assemble the full task prompt for a sub-agent by combining role system
   * prompt, file boundaries, context, and the actual task.
   */
  private _buildPrompt(role: AgentRole, config: SpawnConfig): string {
    const parts: string[] = [];

    // Role identity and instructions
    parts.push(`=== ROLE: ${role.name.toUpperCase()} ===`);
    parts.push(role.systemPrompt);

    // File boundaries
    if (config.fileBoundaries && config.fileBoundaries.length > 0) {
      parts.push('');
      parts.push('=== FILE BOUNDARIES ===');
      parts.push('You should focus on these files/directories:');
      for (const fb of config.fileBoundaries) {
        parts.push(`  - ${fb}`);
      }
      parts.push('Do not modify files outside these boundaries.');
    }

    // Context from prior waves
    if (config.context) {
      parts.push('');
      parts.push('=== CONTEXT FROM PRIOR AGENTS ===');
      parts.push(config.context);
    }

    // The actual task
    parts.push('');
    parts.push('=== YOUR TASK ===');
    parts.push(config.task);

    return parts.join('\n');
  }
}
