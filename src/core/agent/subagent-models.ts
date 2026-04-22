import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const log = createLogger('agent:subagent-models');

export type SubagentModel = 'fork' | 'teammate' | 'worktree';

export interface SubagentOptions {
  model?: SubagentModel;
  task?: string;
  context?: string;
  timeoutMs?: number;
  workdir?: string;
}

export interface SubagentResult {
  model: SubagentModel;
  success: boolean;
  output: string;
  durationMs: number;
  agentId: string;
}

function validatePort(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

const API_BASE = `http://localhost:${validatePort(process.env['GATEWAY_PORT'], 18800)}`;

async function callAgent(message: string, sessionId: string, timeoutMs = 60000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json() as { reply?: string; message?: string; content?: string };
    return data.reply ?? data.message ?? data.content ?? JSON.stringify(data);
  } finally {
    clearTimeout(timer);
  }
}

/** FORK — isolated execution, no shared context. Fast, parallel. */
export async function forkAgent(task: string, options: Partial<SubagentOptions> = {}): Promise<SubagentResult> {
  const agentId = genId();
  const start = Date.now();
  const sessionId = `fork-${agentId}`;
  log.info({ agentId, task: task.slice(0, 80) }, 'Forking agent');
  try {
    const output = await callAgent(`[FORK AGENT] ${task}`, sessionId, options.timeoutMs ?? 120000);
    return { model: 'fork', success: true, output, durationMs: Date.now() - start, agentId };
  } catch (e) {
    return { model: 'fork', success: false, output: String(e), durationMs: Date.now() - start, agentId };
  }
}

/** TEAMMATE — shared context, collaborative. Use for continuation work. */
export async function teammateAgent(task: string, context: string, options: Partial<SubagentOptions> = {}): Promise<SubagentResult> {
  const agentId = genId();
  const start = Date.now();
  const sessionId = `teammate-${agentId}`;
  log.info({ agentId, task: task.slice(0, 80) }, 'Spawning teammate agent');
  const message = `[TEAMMATE AGENT]\nContext from previous work:\n${context.slice(0, 3000)}\n\nYour task: ${task}`;
  try {
    const output = await callAgent(message, sessionId, options.timeoutMs ?? 180000);
    return { model: 'teammate', success: true, output, durationMs: Date.now() - start, agentId };
  } catch (e) {
    return { model: 'teammate', success: false, output: String(e), durationMs: Date.now() - start, agentId };
  }
}

/** WORKTREE — isolated temp directory for file operations. */
export async function worktreeAgent(task: string, options: Partial<SubagentOptions> = {}): Promise<SubagentResult> {
  const agentId = genId();
  const start = Date.now();
  const sessionId = `worktree-${agentId}`;
  const workdir = options.workdir ?? mkdtempSync(path.join(tmpdir(), 'sudo-worktree-'));
  log.info({ agentId, workdir, task: task.slice(0, 80) }, 'Spawning worktree agent');
  const message = `[WORKTREE AGENT]\nIsolated working directory: ${workdir}\nAll file operations should use this directory.\n\nTask: ${task}`;
  try {
    const output = await callAgent(message, sessionId, options.timeoutMs ?? 300000);
    return { model: 'worktree', success: true, output, durationMs: Date.now() - start, agentId };
  } catch (e) {
    return { model: 'worktree', success: false, output: String(e), durationMs: Date.now() - start, agentId };
  }
}

/** Recommend the best subagent model for a given task description. */
export function recommendModel(task: string): SubagentModel {
  const t = task.toLowerCase();
  if (/\b(continue|follow.?up|based on|previous|earlier|we were)\b/.test(t)) return 'teammate';
  if (/\b(code|file|write|edit|create|build|implement|modify)\b/.test(t)) return 'worktree';
  return 'fork'; // default: isolated
}
