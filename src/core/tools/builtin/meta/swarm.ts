/**
 * meta.swarm — Tool for SUDO-AI multi-agent swarm intelligence.
 *
 * Actions:
 *   spawn          — Create a new specialized sub-agent
 *   list-agents    — List all agents, with optional role/status filter
 *   assign-task    — Create a task and assign it to the best available agent
 *   status         — Get swarm-wide health and performance summary
 *   history        — Retrieve recent task history
 *   scale-up       — Spawn N new agents of a given role in one call
 *   share-knowledge — Record a knowledge item from a given agent
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { SwarmManager } from '../../../swarm/index.js';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';

const logger = createLogger('meta.swarm');

const DB_PATH = path.join(DATA_DIR, 'swarm.db');

/** Lazy singleton — one SwarmManager per process lifetime. */
let _manager: SwarmManager | null = null;
function getManager(): SwarmManager {
  if (!_manager) _manager = new SwarmManager(DB_PATH);
  return _manager;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const swarmTool: ToolDefinition = {
  name: 'meta.swarm',
  description:
    'Multi-agent swarm intelligence for SUDO-AI. Spawn specialized sub-agents, distribute tasks to the best-suited agent, share collective knowledge, vote on decisions, and auto-scale the swarm up or down. All state is persisted to data/swarm.db.',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Swarm operation to perform.',
      enum: ['spawn', 'list-agents', 'assign-task', 'status', 'history', 'scale-up', 'share-knowledge'],
    },
    // spawn / scale-up
    name: {
      type: 'string',
      description: 'Agent name (required for spawn).',
    },
    role: {
      type: 'string',
      description: 'Agent role: researcher, coder, analyst, creator, monitor, or custom (required for spawn, scale-up).',
    },
    specialization: {
      type: 'array',
      description: 'List of skills/topics this agent specialises in (required for spawn).',
      items: { type: 'string', description: 'A single specialization keyword.' },
    },
    // list-agents
    filterStatus: {
      type: 'string',
      description: 'Filter agents by status (idle, working, completed, failed, terminated).',
      enum: ['idle', 'working', 'completed', 'failed', 'terminated'],
    },
    filterRole: {
      type: 'string',
      description: 'Filter agents by role string.',
    },
    // assign-task
    taskId: {
      type: 'string',
      description: 'Unique task ID (required for assign-task). If omitted a UUID is generated.',
    },
    taskDescription: {
      type: 'string',
      description: 'What the task requires (required for assign-task).',
    },
    requiredRole: {
      type: 'string',
      description: 'Role that must handle this task (required for assign-task).',
    },
    priority: {
      type: 'number',
      description: 'Task priority 1–10, higher = more urgent (default 5).',
      default: 5,
    },
    // history
    limit: {
      type: 'number',
      description: 'Max number of history entries to return (default 20, max 500).',
      default: 20,
    },
    // scale-up
    count: {
      type: 'number',
      description: 'Number of agents to spawn or terminate (required for scale-up).',
    },
    // share-knowledge
    agentId: {
      type: 'string',
      description: 'Agent ID contributing knowledge (required for share-knowledge).',
    },
    knowledge: {
      type: 'string',
      description: 'The knowledge text to share with the swarm (required for share-knowledge).',
    },
    category: {
      type: 'string',
      description: 'Knowledge category tag (default: general).',
      default: 'general',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.swarm invoked');

    if (!action?.trim()) {
      return { success: false, output: 'action is required.' };
    }

    try {
      const mgr = getManager();

      switch (action) {

        // ----------------------------------------------------------------
        case 'spawn': {
          const name = (params['name'] as string | undefined)?.trim();
          const role = (params['role'] as string | undefined)?.trim();
          const specialization = (params['specialization'] as string[] | undefined) ?? [];

          if (!name) return { success: false, output: 'name is required for spawn.' };
          if (!role) return { success: false, output: 'role is required for spawn.' };
          if (!Array.isArray(specialization)) return { success: false, output: 'specialization must be an array.' };

          const agent = mgr.spawnAgent(name, role, specialization);
          logger.info({ agentId: agent.id, name, role }, 'Agent spawned via tool');
          return {
            success: true,
            output: `Agent spawned: "${name}" (${role}) | id: ${agent.id} | specializations: ${specialization.join(', ') || 'none'}`,
            data: agent,
          };
        }

        // ----------------------------------------------------------------
        case 'list-agents': {
          const filterStatus = params['filterStatus'] as string | undefined;
          const filterRole   = params['filterRole']   as string | undefined;
          const agents = mgr.listAgents({
            status: filterStatus?.trim() || undefined,
            role:   filterRole?.trim()   || undefined,
          });
          if (agents.length === 0) {
            return { success: true, output: 'No agents found matching the given filters.', data: [] };
          }
          const lines = agents.map(a =>
            `[${a.id.slice(0, 8)}] ${a.name} (${a.role}) — ${a.status} | tasks: ${a.performance.tasksCompleted} | success: ${(a.performance.successRate * 100).toFixed(0)}%`
          );
          return {
            success: true,
            output: `${agents.length} agent(s):\n${lines.join('\n')}`,
            data: agents,
          };
        }

        // ----------------------------------------------------------------
        case 'assign-task': {
          const description = (params['taskDescription'] as string | undefined)?.trim();
          const requiredRole = (params['requiredRole'] as string | undefined)?.trim();
          const taskId = ((params['taskId'] as string | undefined)?.trim()) || crypto.randomUUID();
          const priority = Math.max(1, Math.min(10, Number(params['priority'] ?? 5)));

          if (!description) return { success: false, output: 'taskDescription is required for assign-task.' };
          if (!requiredRole) return { success: false, output: 'requiredRole is required for assign-task.' };

          const assignedAgentId = mgr.assignTask({ id: taskId, description, requiredRole, priority, status: 'pending' });
          const agent = mgr.getAgent(assignedAgentId);
          logger.info({ taskId, assignedAgentId, requiredRole }, 'Task assigned via tool');
          return {
            success: true,
            output: `Task assigned.\n  Task ID:  ${taskId}\n  Agent:    ${agent?.name ?? assignedAgentId} (${agent?.role})\n  Priority: ${priority}`,
            data: { taskId, assignedAgentId, agentName: agent?.name, agentRole: agent?.role },
          };
        }

        // ----------------------------------------------------------------
        case 'status': {
          const s = mgr.getSwarmStatus();
          const output = [
            `Swarm Status`,
            `  Total agents:   ${s.total}`,
            `  Active (working): ${s.active}`,
            `  Idle:           ${s.idle}`,
            `  Avg performance: ${(s.avgPerformance * 100).toFixed(1)}%`,
          ].join('\n');
          return { success: true, output, data: s };
        }

        // ----------------------------------------------------------------
        case 'history': {
          const limit = Math.max(1, Math.min(500, Number(params['limit'] ?? 20)));
          const tasks = mgr.getSwarmHistory(limit);
          if (tasks.length === 0) {
            return { success: true, output: 'No task history found.', data: [] };
          }
          const lines = tasks.map(t =>
            `[${t.id.slice(0, 8)}] ${t.status.toUpperCase()} | role:${t.requiredRole} | p:${t.priority} — ${t.description.slice(0, 60)}`
          );
          return {
            success: true,
            output: `${tasks.length} task(s) in history:\n${lines.join('\n')}`,
            data: tasks,
          };
        }

        // ----------------------------------------------------------------
        case 'scale-up': {
          const role  = (params['role']  as string | undefined)?.trim();
          const count = Math.max(1, Math.min(20, Math.floor(Number(params['count'] ?? 1))));

          if (!role) return { success: false, output: 'role is required for scale-up.' };
          if (!Number.isFinite(count)) return { success: false, output: 'count must be a number.' };

          const agents = mgr.scaleUp(role, count);
          logger.info({ role, count: agents.length }, 'Swarm scaled up via tool');
          return {
            success: true,
            output: `Spawned ${agents.length} new "${role}" agent(s).\n${agents.map(a => `  • ${a.name} (${a.id.slice(0, 8)})`).join('\n')}`,
            data: agents,
          };
        }

        // ----------------------------------------------------------------
        case 'share-knowledge': {
          const agentId  = (params['agentId']   as string | undefined)?.trim();
          const knowledge = (params['knowledge'] as string | undefined)?.trim();
          const category  = ((params['category'] as string | undefined)?.trim()) || 'general';

          if (!agentId)  return { success: false, output: 'agentId is required for share-knowledge.' };
          if (!knowledge) return { success: false, output: 'knowledge is required for share-knowledge.' };

          const agent = mgr.getAgent(agentId);
          if (!agent) return { success: false, output: `Agent not found: ${agentId}` };

          mgr.shareKnowledge(agentId, knowledge, category);
          logger.info({ agentId, category, length: knowledge.length }, 'Knowledge shared via tool');
          return {
            success: true,
            output: `Knowledge shared by agent "${agent.name}" under category "${category}" (${knowledge.length} chars).`,
            data: { agentId, agentName: agent.name, category, length: knowledge.length },
          };
        }

        // ----------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: "${action}". Valid: spawn, list-agents, assign-task, status, history, scale-up, share-knowledge.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.swarm error');
      return { success: false, output: `Swarm error: ${msg}` };
    }
  },
};
