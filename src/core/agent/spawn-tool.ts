/**
 * @file spawn-tool.ts
 * @description Tool definition that lets the Brain spawn sub-agents via AgentSwarm.
 *
 * Tool name: 'agent.spawn'
 * Category:  'system'
 *
 * Register this tool on the ToolRegistry after constructing an AgentSwarm:
 *
 *   import { createSpawnTool } from './spawn-tool.js';
 *   registry.register(createSpawnTool(swarm));
 */

import { createLogger } from '../shared/index.js';
import type { ToolDefinition, ToolResult, ToolContext } from '../tools/types.js';
import type { AgentSwarm } from './swarm.js';

const log = createLogger('agent:spawn-tool');

/**
 * Create the 'agent.spawn' ToolDefinition bound to the given AgentSwarm.
 *
 * @param swarm - AgentSwarm instance that will run the sub-agent.
 * @returns A fully configured ToolDefinition ready to register.
 */
export function createSpawnTool(swarm: AgentSwarm): ToolDefinition {
  return {
    name: 'agent.spawn',
    description:
      'Spawn an isolated sub-agent to handle a self-contained task in parallel. ' +
      'The sub-agent has access to all tools and will return a result string. ' +
      'Use for tasks that can be parallelised or delegated completely.',
    category: 'system',
    timeout: 6 * 60 * 1_000, // 6 min (slightly above sub-agent default)

    parameters: {
      task: {
        type: 'string',
        description:
          'A complete, self-contained task description for the sub-agent. ' +
          'Include all context needed — sub-agents do not share conversation history.',
        required: true,
      },
      model: {
        type: 'string',
        description: 'Optional LLM model override for this sub-agent. Leave empty to use the default.',
        required: false,
      },
      persona: {
        type: 'string',
        description: 'Optional persona override: producer, researcher, marketer, coder, creative, assistant.',
        required: false,
        enum: ['producer', 'researcher', 'marketer', 'coder', 'creative', 'assistant'],
      },
      timeout: {
        type: 'number',
        description: 'Wall-clock timeout in milliseconds. Defaults to 300000 (5 minutes).',
        required: false,
        default: 300_000,
      },
    },

    async execute(
      params: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      const task = params['task'];
      if (!task || typeof task !== 'string' || !task.trim()) {
        return {
          success: false,
          output: 'agent.spawn: task parameter is required and must be a non-empty string.',
        };
      }

      const model = typeof params['model'] === 'string' ? params['model'] : undefined;
      const persona = typeof params['persona'] === 'string' ? params['persona'] : undefined;
      const timeoutRaw = params['timeout'];
      const timeout =
        typeof timeoutRaw === 'number' && timeoutRaw > 0 ? timeoutRaw : undefined;

      log.info(
        { taskPreview: task.slice(0, 100), model, persona, timeout },
        'agent.spawn tool called',
      );

      const active = swarm.getActive();
      if (active.length >= 4) {
        log.warn({ activeCount: active.length }, 'agent.spawn: max concurrent sub-agents reached');
        return {
          success: false,
          output: `Cannot spawn sub-agent: ${active.length} sub-agents already running (max 4). Try again when one completes.`,
        };
      }

      try {
        const result = await swarm.spawn(task.trim(), { model, persona, timeout });

        log.info({ taskPreview: task.slice(0, 60), resultLen: result.length }, 'Sub-agent result received');

        return {
          success: true,
          output: result,
          data: { taskLength: task.length, resultLength: result.length },
        };
      } catch (err) {
        log.error({ task: task.slice(0, 80), err }, 'agent.spawn: sub-agent failed');
        return {
          success: false,
          output: `Sub-agent failed: ${String(err)}`,
        };
      }
    },
  };
}
