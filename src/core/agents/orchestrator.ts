/**
 * @file orchestrator.ts
 * @description MultiAgentOrchestrator — wave-based multi-agent pipeline manager.
 *
 * Agents within a wave run in parallel (up to swarm concurrency of 4).
 * Results from completed waves feed into the next wave's context.
 * Also exports createMultiAgentTool() for the 'system.spawn-agent' tool.
 */

import { createLogger } from '../shared/index.js';
import { PipelineError } from '../shared/index.js';
import { AgentSpawner } from './spawner.js';
import { AgentMessenger } from './messenger.js';
import { ROLE_NAMES } from './roles.js';
import type { AgentInstance, AgentRoleName, PipelineResult, SpawnConfig, Wave, WaveResult } from './types.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const log = createLogger('agents:orchestrator');

/** Coordinates multi-wave agent pipelines. */
export class MultiAgentOrchestrator {
  private readonly spawner: AgentSpawner;
  private readonly messenger = new AgentMessenger();
  private running = false;

  constructor(brain: unknown, toolRegistry: unknown, sessionManager: unknown) {
    this.spawner = new AgentSpawner(brain, toolRegistry, sessionManager);
    log.info('MultiAgentOrchestrator initialized');
  }

  /**
   * Execute a multi-wave pipeline. Waves run sequentially; agents within
   * each wave run in parallel.
   */
  async runPipeline(task: string, waves: Wave[]): Promise<PipelineResult> {
    if (this.running) {
      throw new PipelineError('A pipeline is already running.', 'pipeline_already_running');
    }
    if (!waves?.length) {
      throw new PipelineError('waves must be non-empty', 'pipeline_invalid_args');
    }

    this.running = true;
    this.messenger.clear();
    const start = Date.now();
    const waveResults: WaveResult[] = [];

    log.info({ task: task.slice(0, 120), waveCount: waves.length }, 'Pipeline started');

    try {
      let ctx = '';
      for (const wave of waves) {
        const ws = Date.now();
        const configs = wave.agents.map((a) => ({
          ...a,
          context: [ctx, a.context ?? ''].filter(Boolean).join('\n\n') || undefined,
        }));

        const results = await Promise.all(configs.map((c) => this.spawner.spawn(c)));

        for (const a of results) {
          this.messenger.send({
            from: a.id,
            to: 'all',
            type: a.status === 'completed' ? 'result' : 'error',
            content: `[${a.role}] ${a.status === 'completed' ? a.result ?? '' : a.error ?? ''}`,
          });
        }

        const waveCtx = results
          .filter((a) => a.status === 'completed' && a.result)
          .map((a) => `[${a.role} result]:\n${a.result}`)
          .join('\n\n');
        if (waveCtx) ctx = ctx ? `${ctx}\n\n${waveCtx}` : waveCtx;

        waveResults.push({ name: wave.name, agents: results, durationMs: Date.now() - ws });
      }

      const all = waveResults.flatMap((w) => w.agents);
      const ok = all.filter((a) => a.status === 'completed').length;
      const fail = all.filter((a) => a.status === 'failed').length;
      const totalMs = Date.now() - start;

      return {
        waves: waveResults,
        totalDurationMs: totalMs,
        success: fail === 0,
        summary: `Pipeline ${fail === 0 ? 'SUCCEEDED' : 'FAILED'} | ${waves.length} waves, ${all.length} agents (${ok} ok, ${fail} fail) | ${(totalMs / 1000).toFixed(1)}s`,
      };
    } finally {
      this.running = false;
    }
  }

  /** Spawn a single agent outside a pipeline. */
  async spawnAgent(config: SpawnConfig): Promise<AgentInstance> {
    return this.spawner.spawn(config);
  }

  /** Currently running/pending agents. */
  getActiveAgents(): AgentInstance[] {
    return this.spawner.getInstances().filter((a) => a.status === 'running' || a.status === 'pending');
  }

  /** All agent instances including completed/failed. */
  getAllAgents(): AgentInstance[] {
    return this.spawner.getInstances();
  }

  /** The inter-agent message bus. */
  getMessenger(): AgentMessenger {
    return this.messenger;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Cancel all running agents and stop the pipeline. */
  cancelAll(): void {
    this.spawner.cancelAll();
    this.running = false;
    log.info('All agents and pipeline cancelled');
  }
}

// ---------------------------------------------------------------------------
// Tool factory: system.spawn-agent
// ---------------------------------------------------------------------------

/**
 * Create the 'system.spawn-agent' ToolDefinition bound to an orchestrator.
 * Role-aware spawn tool, distinct from the basic 'agent.spawn'.
 */
export function createMultiAgentTool(orchestrator: MultiAgentOrchestrator): ToolDefinition {
  return {
    name: 'system.spawn-agent',
    description:
      'Spawn a specialised sub-agent with a predefined role (architect, coder, researcher, reviewer, debugger, tester). Returns the agent result.',
    category: 'system',
    timeout: 7 * 60 * 1_000,
    parameters: {
      role: { type: 'string', description: 'Specialist role.', required: true, enum: [...ROLE_NAMES] },
      task: { type: 'string', description: 'Self-contained task description.', required: true },
      context: { type: 'string', description: 'Optional context from prior results.', required: false },
      fileBoundaries: { type: 'string', description: 'Comma-separated file/dir paths to focus on.', required: false },
    },

    async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const role = params['role'];
      if (!role || typeof role !== 'string' || !(ROLE_NAMES as readonly string[]).includes(role)) {
        return { success: false, output: `Invalid role "${String(role)}". Valid: ${ROLE_NAMES.join(', ')}` };
      }

      const task = params['task'];
      if (!task || typeof task !== 'string' || !String(task).trim()) {
        return { success: false, output: 'task is required and must be non-empty.' };
      }

      if (orchestrator.getActiveAgents().length >= 4) {
        return { success: false, output: 'Max 4 concurrent agents. Wait for one to finish.' };
      }

      const context = typeof params['context'] === 'string' ? params['context'] : undefined;
      const fb = typeof params['fileBoundaries'] === 'string'
        ? params['fileBoundaries'].split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      try {
        const inst = await orchestrator.spawnAgent({
          // Membership in ROLE_NAMES was checked above.
          role: role as AgentRoleName, task: String(task).trim(), context, fileBoundaries: fb,
        });

        if (inst.status === 'completed') {
          return {
            success: true,
            output: inst.result ?? '(no output)',
            data: { agentId: inst.id, role: inst.role },
          };
        }
        return { success: false, output: `Agent failed: ${inst.error ?? 'unknown'}` };
      } catch (err) {
        return { success: false, output: `spawn-agent error: ${String(err)}` };
      }
    },
  };
}
