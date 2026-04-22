/**
 * system.cron — System crontab management via crontab(1).
 * Reads/writes crontabs for a given user (default: root).
 */

import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.cron');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronEntry {
  expression: string;
  command: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRON_EXPR_RE = /^(@\w+|[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+)\s+(.+)$/;
const COMMENT_RE = /^\s*#/;

function parseCrontab(content: string): CronEntry[] {
  return content
    .split('\n')
    .filter((line) => line.trim() && !COMMENT_RE.test(line))
    .map((line) => {
      const match = CRON_EXPR_RE.exec(line.trim());
      if (!match) return null;
      return { expression: match[1]?.trim() ?? '', command: match[2]?.trim() ?? '', raw: line.trim() };
    })
    .filter((e): e is CronEntry => e !== null);
}

function validateCronExpression(expr: string): boolean {
  return /^(@\w+|[\d*/,\-]+ [\d*/,\-]+ [\d*/,\-]+ [\d*/,\-]+ [\d*/,\-]+)$/.test(expr.trim());
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listCrons(user: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, user }, 'Listing crontab');
  const { stdout, exitCode } = await runCmd(
    'crontab',
    ['-u', user, '-l'],
    { signal: ctx.signal, allowFailure: true },
  );

  if (exitCode !== 0 && stdout === '') {
    return { success: true, output: `No crontab for user "${user}"`, data: { user, entries: [] } };
  }

  const entries = parseCrontab(stdout);
  return {
    success: true,
    output: `${entries.length} cron job(s) for "${user}"`,
    data: { user, entries },
  };
}

async function addCron(
  user: string,
  expression: string,
  command: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, user, expression }, 'Adding cron job');

  if (!validateCronExpression(expression)) {
    return { success: false, output: `Invalid cron expression: ${expression}`, data: {} };
  }
  if (!command.trim()) {
    return { success: false, output: 'Command is required', data: {} };
  }

  // Read existing crontab (may be empty).
  const { stdout: existing } = await runCmd(
    'crontab',
    ['-u', user, '-l'],
    { signal: ctx.signal, allowFailure: true },
  );

  const newEntry = `${expression} ${command}`;
  const newCrontab = existing ? `${existing}\n${newEntry}\n` : `${newEntry}\n`;

  // Write via stdin using echo piping is disallowed; use a temp approach via
  // execFile('bash', ...) is also disallowed. Use crontab's stdin by writing
  // to a temp file through writeFile then crontab <file.
  const tmpPath = join(tmpdir(), `sudo-cron-${Date.now()}.txt`);

  await writeFile(tmpPath, newCrontab, 'utf8');
  try {
    await runCmd('crontab', ['-u', user, tmpPath], { signal: ctx.signal });
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }

  return {
    success: true,
    output: `Cron job added for "${user}": ${newEntry}`,
    data: { user, expression, command, entry: newEntry },
  };
}

async function removeCron(
  user: string,
  command: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, user, command }, 'Removing cron job');

  const { stdout: existing } = await runCmd(
    'crontab',
    ['-u', user, '-l'],
    { signal: ctx.signal, allowFailure: true },
  );

  if (!existing) {
    return { success: false, output: `No crontab for user "${user}"`, data: {} };
  }

  const filtered = existing
    .split('\n')
    .filter((line) => !line.includes(command))
    .join('\n');

  if (filtered === existing) {
    return { success: false, output: `No cron job matching command: ${command}`, data: {} };
  }

  const tmpPath = join(tmpdir(), `sudo-cron-${Date.now()}.txt`);

  await writeFile(tmpPath, filtered + '\n', 'utf8');
  try {
    await runCmd('crontab', ['-u', user, tmpPath], { signal: ctx.signal });
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }

  return {
    success: true,
    output: `Cron job matching "${command}" removed for "${user}"`,
    data: { user, command },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const cronTool: ToolDefinition = {
  name: 'system.cron',
  description: 'Manage system crontabs: list, add, or remove scheduled jobs for a user.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 15_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: list | add | remove',
      required: true,
      enum: ['list', 'add', 'remove'],
    },
    expression: {
      type: 'string',
      description: 'Cron expression (e.g. "0 2 * * *" or "@daily")',
    },
    command: {
      type: 'string',
      description: 'Shell command to schedule (or partial match for remove)',
    },
    user: {
      type: 'string',
      description: 'Linux user whose crontab to manage (default: root)',
      default: 'root',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const user = (params['user'] as string | undefined) ?? 'root';
    const expression = params['expression'] as string | undefined;
    const command = params['command'] as string | undefined;

    if (!/^[\w-]+$/.test(user)) {
      return { success: false, output: `Invalid user: ${user}`, data: {} };
    }

    try {
      switch (op) {
        case 'list':
          return listCrons(user, ctx);
        case 'add':
          return addCron(user, expression ?? '', command ?? '', ctx);
        case 'remove':
          return removeCron(user, command ?? '', ctx);
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      return handleNotInstalled(err, 'crontab') as ToolResult;
    }
  },
};
