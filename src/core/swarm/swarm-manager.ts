/**
 * Swarm Manager — SUDO spawns and coordinates specialized sub-agents.
 * Schema DDL and row helpers live in swarm-schema.ts.
 * Uses better-sqlite3 synchronously. Named parameters only — no string interpolation.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  SWARM_SCHEMA,
  rowToAgent,
  rowToTask,
  type AgentRow,
  type TaskRow,
} from './swarm-schema.js';

const logger = createLogger('swarm-manager');

export interface SwarmAgent {
  id: string;
  name: string;
  role: string; // researcher | coder | analyst | creator | monitor | <custom>
  status: 'idle' | 'working' | 'completed' | 'failed' | 'terminated';
  currentTask?: string;
  specialization: string[];
  performance: {
    tasksCompleted: number;
    successRate: number;
    avgDurationMs: number;
  };
  spawnedAt: string;
  lastActiveAt: string;
}

export interface SwarmTask {
  id: string;
  description: string;
  assignedTo?: string;
  requiredRole: string;
  priority: number;
  result?: unknown;
  status: 'pending' | 'assigned' | 'completed' | 'failed';
}

export class SwarmManager {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SwarmManager: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    for (const stmt of SWARM_SCHEMA) {
      try { this.db.exec(stmt); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          logger.warn({ stmt: stmt.slice(0, 80), msg }, 'Schema warning');
        }
      }
    }
    logger.info({ dbPath }, 'SwarmManager initialised');
  }

  // --- Agent lifecycle ---

  spawnAgent(name: string, role: string, specialization: string[]): SwarmAgent {
    if (!name?.trim())  throw new TypeError('spawnAgent: name is required');
    if (!role?.trim())  throw new TypeError('spawnAgent: role is required');
    if (!Array.isArray(specialization)) throw new TypeError('spawnAgent: specialization must be an array');

    const id  = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_agents (id, name, role, specialization, spawned_at, last_active_at)
      VALUES (:id, :name, :role, :specialization, :now, :now)
    `).run({ id, name: name.trim(), role: role.trim(), specialization: JSON.stringify(specialization), now });

    logger.info({ id, name, role }, 'Agent spawned');
    return this.getAgent(id)!;
  }

  terminateAgent(agentId: string): void {
    if (!agentId?.trim()) throw new TypeError('terminateAgent: agentId is required');
    const info = this.db.prepare(`
      UPDATE swarm_agents SET status = 'terminated', last_active_at = :now WHERE id = :id
    `).run({ id: agentId, now: new Date().toISOString() });
    if (info.changes === 0) throw new Error(`terminateAgent: agent not found: ${agentId}`);
    logger.info({ agentId }, 'Agent terminated');
  }

  getAgent(agentId: string): SwarmAgent | null {
    if (!agentId?.trim()) return null;
    const row = this.db.prepare<{ id: string }, AgentRow>(
      'SELECT * FROM swarm_agents WHERE id = :id'
    ).get({ id: agentId });
    return row ? rowToAgent(row) : null;
  }

  listAgents(filter?: { status?: string; role?: string }): SwarmAgent[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.status) { conditions.push('status = :status'); params['status'] = filter.status; }
    if (filter?.role)   { conditions.push('role   = :role');   params['role']   = filter.role; }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare<Record<string, string>, AgentRow>(
      `SELECT * FROM swarm_agents ${where} ORDER BY spawned_at DESC`
    ).all(params);
    return rows.map(rowToAgent);
  }

  // --- Task distribution ---

  assignTask(task: SwarmTask): string {
    if (!task?.id?.trim())           throw new TypeError('assignTask: task.id is required');
    if (!task?.description?.trim())  throw new TypeError('assignTask: task.description is required');
    if (!task?.requiredRole?.trim()) throw new TypeError('assignTask: task.requiredRole is required');

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_tasks (id, description, required_role, priority, status, created_at)
      VALUES (:id, :description, :required_role, :priority, 'pending', :now)
      ON CONFLICT(id) DO UPDATE SET
        description   = excluded.description,
        priority      = excluded.priority
    `).run({
      id: task.id,
      description: task.description,
      required_role: task.requiredRole,
      priority: task.priority ?? 5,
      now,
    });

    const agent = this.getBestAgent(task.requiredRole);
    if (!agent) {
      logger.warn({ taskId: task.id, role: task.requiredRole }, 'No suitable agent found');
      throw new Error(`No available agent for role: ${task.requiredRole}`);
    }

    this.db.prepare(`
      UPDATE swarm_tasks SET assigned_to = :agentId, status = 'assigned' WHERE id = :id
    `).run({ agentId: agent.id, id: task.id });

    this.db.prepare(`
      UPDATE swarm_agents
      SET status = 'working', current_task = :taskId, last_active_at = :now
      WHERE id = :agentId
    `).run({ taskId: task.id, now, agentId: agent.id });

    logger.info({ taskId: task.id, agentId: agent.id, role: task.requiredRole }, 'Task assigned');
    return agent.id;
  }

  getBestAgent(role: string, specialization?: string): SwarmAgent | null {
    if (!role?.trim()) return null;
    const rows = this.db.prepare<{ role: string }, AgentRow>(`
      SELECT * FROM swarm_agents
      WHERE role = :role AND status = 'idle'
      ORDER BY success_rate DESC, tasks_completed DESC
      LIMIT 10
    `).all({ role });

    if (rows.length === 0) return null;

    if (specialization) {
      const match = rows.find(r => {
        try {
          const specs = JSON.parse(r.specialization) as string[];
          return specs.includes(specialization);
        } catch { return false; }
      });
      if (match) return rowToAgent(match);
    }
    return rowToAgent(rows[0]!);
  }

  // --- Collective intelligence ---

  /** Each idle agent votes; winner is highest vote-count option. */
  requestVote(question: string, options: string[]): { option: string; votes: number }[] {
    if (!question?.trim()) throw new TypeError('requestVote: question is required');
    if (!Array.isArray(options) || options.length === 0) {
      throw new TypeError('requestVote: options must be a non-empty array');
    }

    const agents = this.listAgents({ status: 'idle' });
    if (agents.length === 0) return options.map(o => ({ option: o, votes: 0 }));

    const tally = new Map<string, number>(options.map(o => [o, 0]));
    const words  = question.toLowerCase().split(/\W+/);

    for (const agent of agents) {
      let bestScore  = -1;
      let bestOption = options[0]!;
      for (const opt of options) {
        const specScore = agent.specialization
          .filter(s => words.some(w => s.toLowerCase().includes(w))).length;
        const roleScore = opt.toLowerCase().includes(agent.role.toLowerCase()) ? 2 : 0;
        const score     = specScore + roleScore;
        if (score > bestScore) { bestScore = score; bestOption = opt; }
      }
      tally.set(bestOption, (tally.get(bestOption) ?? 0) + 1);
    }

    logger.info({ question, agentCount: agents.length }, 'Swarm vote completed');
    return [...tally.entries()]
      .map(([option, votes]) => ({ option, votes }))
      .sort((a, b) => b.votes - a.votes);
  }

  shareKnowledge(agentId: string, knowledge: string, category = 'general'): void {
    if (!agentId?.trim())   throw new TypeError('shareKnowledge: agentId is required');
    if (!knowledge?.trim()) throw new TypeError('shareKnowledge: knowledge is required');

    this.db.prepare(`
      INSERT INTO swarm_knowledge (agent_id, knowledge, category)
      VALUES (:agentId, :knowledge, :category)
    `).run({ agentId, knowledge: knowledge.trim(), category: category.trim() || 'general' });

    this.db.prepare(`
      UPDATE swarm_agents SET last_active_at = :now WHERE id = :id
    `).run({ now: new Date().toISOString(), id: agentId });

    logger.info({ agentId, category, length: knowledge.length }, 'Knowledge shared');
  }

  // --- Monitoring ---

  getSwarmStatus(): { total: number; active: number; idle: number; avgPerformance: number } {
    const row = this.db.prepare<Record<string, never>, {
      total: number; active: number; idle: number; avg_perf: number | null;
    }>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'idle'    THEN 1 ELSE 0 END) AS idle,
        AVG(success_rate) AS avg_perf
      FROM swarm_agents
      WHERE status != 'terminated'
    `).get({})!;
    return {
      total:          row.total,
      active:         row.active,
      idle:           row.idle,
      avgPerformance: Math.round((row.avg_perf ?? 0) * 1000) / 1000,
    };
  }

  getSwarmHistory(limit = 20): SwarmTask[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare<{ limit: number }, TaskRow>(`
      SELECT * FROM swarm_tasks ORDER BY created_at DESC LIMIT :limit
    `).all({ limit: safeLimit });
    return rows.map(rowToTask);
  }

  // --- Auto-scaling ---

  scaleUp(role: string, count: number): SwarmAgent[] {
    if (!role?.trim()) throw new TypeError('scaleUp: role is required');
    const safeCount = Math.max(1, Math.min(20, Math.floor(count)));
    const spawned: SwarmAgent[] = [];
    for (let i = 0; i < safeCount; i++) {
      const name = `${role}-${Date.now()}-${i}`;
      spawned.push(this.spawnAgent(name, role, [role]));
    }
    logger.info({ role, count: safeCount }, 'Swarm scaled up');
    return spawned;
  }

  scaleDown(role: string, count: number): void {
    if (!role?.trim()) throw new TypeError('scaleDown: role is required');
    const safeCount = Math.max(1, Math.min(20, Math.floor(count)));
    const idle      = this.listAgents({ status: 'idle', role });
    const targets   = idle.slice(0, safeCount);
    for (const agent of targets) this.terminateAgent(agent.id);
    logger.info({ role, requested: safeCount, terminated: targets.length }, 'Swarm scaled down');
  }

  close(): void {
    this.db.close();
    logger.info('SwarmManager database closed');
  }
}
