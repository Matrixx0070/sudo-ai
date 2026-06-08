/**
 * meta.claude-skill — Run any Claude Code agent skill from within SUDO-AI.
 *
 * Discovers skills from ~/.claude/agents/*.md and executes them non-interactively
 * using the Claude CLI (`claude -p --agent <skill> "<task>"`).
 *
 * Available skills: architect, backend, database, debugger, devops, frontend, reviewer, tester
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('custom.claude-skill');

const AGENTS_DIR = path.resolve(os.homedir(), '.claude', 'agents');
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

function listSkills(): { name: string; description: string }[] {
  try {
    if (!existsSync(AGENTS_DIR)) return [];
    return readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const name = f.replace(/\.md$/, '');
        const raw = readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
        const match = raw.match(/^description:\s*(.+)$/m);
        const description = match ? match[1].trim() : '(no description)';
        return { name, description };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const claudeSkillTool: ToolDefinition = {
  name: 'meta.claude-skill',
  description:
    'Run a Claude Code agent skill (architect, backend, database, debugger, devops, frontend, reviewer, tester) ' +
    'on a specific task. The skill runs as a non-interactive Claude Code subprocess with full tool access ' +
    'in the project directory. Use "list" for skill to see all available skills and their descriptions. ' +
    'Great for: code review (reviewer), architecture design (architect), writing tests (tester), ' +
    'debugging errors (debugger), frontend/backend/database work, or deployment (devops).',
  category: 'meta' as const,
  timeout: DEFAULT_TIMEOUT_MS + 10_000,
  parameters: {
    skill: {
      type: 'string',
      description:
        'The skill/agent name to run (e.g. "architect", "reviewer", "tester", "debugger"). ' +
        'Pass "list" to get all available skills and their descriptions.',
    },
    task: {
      type: 'string',
      description:
        'The task description to give the skill agent. Be specific — include file paths, ' +
        'error messages, or acceptance criteria. Not required when skill is "list".',
    },
    workdir: {
      type: 'string',
      description:
        `Working directory for the skill (defaults to ${PROJECT_ROOT}). ` +
        'Use an absolute path if the skill should operate on a different project.',
    },
    timeout_seconds: {
      type: 'number',
      description: 'Max seconds to wait for the skill to complete (default: 300, max: 600).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const skill = (params['skill'] as string | undefined)?.trim() ?? '';
    const task  = (params['task']  as string | undefined)?.trim() ?? '';
    const workdir = (params['workdir'] as string | undefined)?.trim() || PROJECT_ROOT;
    const timeoutSec = Math.min(
      Math.max(Number(params['timeout_seconds'] ?? 300), 30),
      600,
    );

    logger.info({ session: ctx.sessionId, skill, workdir }, 'meta.claude-skill invoked');

    // ------ LIST mode ------
    if (!skill || skill === 'list') {
      const skills = listSkills();
      if (skills.length === 0) {
        return { success: true, output: `No skills found in ${AGENTS_DIR}` };
      }
      const lines = skills.map((s) => `  • ${s.name.padEnd(12)} — ${s.description.slice(0, 100)}`);
      return {
        success: true,
        output: `Available Claude Code skills (${skills.length}):\n${lines.join('\n')}\n\nUsage: skill="architect" task="design the auth module"`,
        data: { skills },
      };
    }

    // ------ VALIDATE skill exists ------
    const skillPath = path.join(AGENTS_DIR, `${skill}.md`);
    if (!existsSync(skillPath)) {
      const skills = listSkills().map((s) => s.name);
      return {
        success: false,
        output: `Unknown skill: "${skill}". Available: ${skills.join(', ')}. Pass skill="list" to see details.`,
      };
    }

    if (!task) {
      return { success: false, output: 'A "task" description is required when running a skill.' };
    }

    // ------ EXECUTE ------
    const timeoutMs = timeoutSec * 1000;
    const cmd = `claude -p --dangerously-skip-permissions --agent ${skill} ${JSON.stringify(task)}`;

    logger.info({ skill, task: task.slice(0, 80), workdir, timeoutSec }, 'Running Claude Code skill');

    try {
      const output = execSync(cmd, {
        cwd: workdir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        encoding: 'utf-8',
        env: { ...process.env },
      });

      const result = output.toString().trim();
      logger.info({ skill, chars: result.length }, 'Skill completed successfully');

      return {
        success: true,
        output: `[${skill.toUpperCase()} SKILL RESULT]\n\n${result}`,
        data: { skill, workdir, chars: result.length },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string };

      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return {
          success: false,
          output: `Skill "${skill}" timed out after ${timeoutSec}s. Try a shorter task or increase timeout_seconds.`,
        };
      }

      const stderr = e.stderr?.toString().trim() ?? '';
      const stdout = e.stdout?.toString().trim() ?? '';
      const detail = stdout || stderr || e.message;

      logger.error({ skill, err: e.message }, 'Skill execution failed');
      return {
        success: false,
        output: `Skill "${skill}" failed:\n${detail}`,
      };
    }
  },
};
