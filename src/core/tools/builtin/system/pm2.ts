/**
 * system.pm2 — PM2 process manager operations.
 * All commands use execFile; output is parsed into structured data.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.pm2');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Pm2Process {
  id: number;
  name: string;
  status: string;
  pid: number;
  cpu: number;
  memory: number;
  restarts: number;
  uptime: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pm2Jlist(ctx: ToolContext): Promise<Pm2Process[]> {
  const { stdout, exitCode } = await runCmd('pm2', ['jlist'], { signal: ctx.signal, allowFailure: true });
  if (exitCode !== 0 || !stdout) return [];
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>[];
    return raw.map((p) => {
      const monit = (p['monit'] as Record<string, number>) ?? {};
      const pm2Env = (p['pm2_env'] as Record<string, unknown>) ?? {};
      return {
        id: (p['pm_id'] as number) ?? 0,
        name: (p['name'] as string) ?? '',
        status: (pm2Env['status'] as string) ?? '',
        pid: (p['pid'] as number) ?? 0,
        cpu: monit['cpu'] ?? 0,
        memory: monit['memory'] ?? 0,
        restarts: (pm2Env['restart_time'] as number) ?? 0,
        uptime: String(pm2Env['pm_uptime'] ?? ''),
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function pm2List(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing PM2 processes');
  const processes = await pm2Jlist(ctx);
  return {
    success: true,
    output: `${processes.length} PM2 process(es)`,
    data: { processes },
  };
}

async function pm2Start(
  name: string,
  script: string | undefined,
  args: string[] | undefined,
  cwd: string | undefined,
  instances: number | undefined,
  ctx: ToolContext,
): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name, script }, 'Starting PM2 process');
  const pmArgs = [
    'start', script ?? name,
    '--name', name,
    ...(instances !== undefined ? ['-i', String(instances)] : []),
    ...(cwd ? ['--cwd', cwd] : []),
    ...(args?.length ? ['--', ...args] : []),
  ];
  await runCmd('pm2', pmArgs, { signal: ctx.signal });
  return { success: true, output: `PM2 started: ${name}`, data: { name } };
}

async function pm2Stop(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Stopping PM2 process');
  await runCmd('pm2', ['stop', name], { signal: ctx.signal });
  return { success: true, output: `PM2 stopped: ${name}`, data: { name } };
}

async function pm2Restart(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Restarting PM2 process');
  await runCmd('pm2', ['restart', name], { signal: ctx.signal });
  return { success: true, output: `PM2 restarted: ${name}`, data: { name } };
}

async function pm2Delete(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Deleting PM2 process');
  await runCmd('pm2', ['delete', name], { signal: ctx.signal });
  return { success: true, output: `PM2 deleted: ${name}`, data: { name } };
}

async function pm2Logs(name: string, lines: number, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, name, lines }, 'Fetching PM2 logs');
  const { stdout } = await runCmd(
    'pm2',
    ['logs', name, '--lines', String(lines), '--nostream'],
    { signal: ctx.signal, allowFailure: true },
  );
  const logLines = stdout.split('\n').filter(Boolean);
  return { success: true, output: `Last ${logLines.length} PM2 log lines for "${name}"`, data: { name, lines: logLines } };
}

async function pm2Monit(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'PM2 monit snapshot');
  const processes = await pm2Jlist(ctx);
  const summary = processes.map((p) => ({
    name: p.name,
    status: p.status,
    cpu: `${p.cpu}%`,
    memory: `${(p.memory / 1024 / 1024).toFixed(1)}MB`,
  }));
  return { success: true, output: `PM2 monit: ${processes.length} process(es)`, data: { processes: summary } };
}

async function pm2Save(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Saving PM2 process list');
  await runCmd('pm2', ['save'], { signal: ctx.signal });
  return { success: true, output: 'PM2 process list saved', data: {} };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pm2Tool: ToolDefinition = {
  name: 'system.pm2',
  description: 'Manage PM2 Node.js processes: start, stop, restart, delete, list, logs, monit, save.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 60_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: start | stop | restart | delete | list | logs | monit | save',
      required: true,
      enum: ['start', 'stop', 'restart', 'delete', 'list', 'logs', 'monit', 'save'],
    },
    name: { type: 'string', description: 'PM2 process name' },
    script: { type: 'string', description: 'Script or binary to run (start operation)' },
    args: {
      type: 'array',
      description: 'Arguments to pass to the script',
      items: { type: 'string', description: 'Argument' },
    },
    cwd: { type: 'string', description: 'Working directory for the process' },
    instances: { type: 'number', description: 'Number of instances (cluster mode), 0 = max CPUs' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    const name = params['name'] as string | undefined;
    const script = params['script'] as string | undefined;
    const args = Array.isArray(params['args']) ? (params['args'] as string[]) : undefined;
    const cwd = params['cwd'] as string | undefined;
    const instances = typeof params['instances'] === 'number' ? params['instances'] : undefined;

    const requireName = (): string => {
      if (!name) throw new Error(`${op} requires name`);
      return name;
    };

    try {
      switch (op) {
        case 'list':    return pm2List(ctx);
        case 'monit':   return pm2Monit(ctx);
        case 'save':    return pm2Save(ctx);
        case 'start':   return pm2Start(requireName(), script, args, cwd, instances, ctx);
        case 'stop':    return pm2Stop(requireName(), ctx);
        case 'restart': return pm2Restart(requireName(), ctx);
        case 'delete':  return pm2Delete(requireName(), ctx);
        case 'logs': {
          const lines = typeof params['lines'] === 'number' ? params['lines'] : 50;
          return pm2Logs(requireName(), lines, ctx);
        }
        default:
          return { success: false, output: `Unknown operation: ${op}`, data: {} };
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('requires name')) {
        return { success: false, output: err.message, data: {} };
      }
      return handleNotInstalled(err, 'pm2') as ToolResult;
    }
  },
};
