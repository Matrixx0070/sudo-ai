/**
 * system.service — systemd service management via systemctl + journalctl.
 * All commands use execFile; no shell interpolation.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd, handleNotInstalled } from './exec.js';

const logger = createLogger('system.service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceStatus {
  name: string;
  loadState: string;
  activeState: string;
  subState: string;
  description: string;
  mainPid?: number;
  memory?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseServiceStatus(name: string, stdout: string): ServiceStatus {
  const extract = (pattern: RegExp): string =>
    pattern.exec(stdout)?.[1]?.trim() ?? '';

  return {
    name,
    loadState: extract(/Loaded:\s+(\S+)/),
    activeState: extract(/Active:\s+(\S+)/),
    subState: extract(/\((\w+)\)/),
    description: extract(/Description:\s+(.+)/),
    mainPid: parseInt(extract(/Main PID:\s+(\d+)/), 10) || undefined,
    memory: extract(/Memory:\s+(\S+)/) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function serviceStart(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Starting service');
  await runCmd('systemctl', ['start', name], { signal: ctx.signal });
  return { success: true, output: `Service "${name}" started`, data: { name, action: 'start' } };
}

async function serviceStop(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Stopping service');
  await runCmd('systemctl', ['stop', name], { signal: ctx.signal });
  return { success: true, output: `Service "${name}" stopped`, data: { name, action: 'stop' } };
}

async function serviceRestart(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.warn({ session: ctx.sessionId, name }, 'Restarting service');
  await runCmd('systemctl', ['restart', name], { signal: ctx.signal });
  return { success: true, output: `Service "${name}" restarted`, data: { name, action: 'restart' } };
}

async function serviceEnable(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, name }, 'Enabling service');
  await runCmd('systemctl', ['enable', name], { signal: ctx.signal });
  return { success: true, output: `Service "${name}" enabled`, data: { name, action: 'enable' } };
}

async function serviceDisable(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, name }, 'Disabling service');
  await runCmd('systemctl', ['disable', name], { signal: ctx.signal });
  return { success: true, output: `Service "${name}" disabled`, data: { name, action: 'disable' } };
}

async function serviceStatus(name: string, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, name }, 'Getting service status');
  const { stdout } = await runCmd(
    'systemctl',
    ['status', name, '--no-pager', '-l'],
    { signal: ctx.signal, allowFailure: true },
  );
  const status = parseServiceStatus(name, stdout);
  const summary = `${name}: ${status.activeState} (${status.subState})`;
  return { success: true, output: summary, data: { status } };
}

async function serviceLogs(name: string, lines: number, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, name, lines }, 'Fetching service logs');
  const { stdout } = await runCmd(
    'journalctl',
    ['-u', name, '-n', String(lines), '--no-pager', '--output=short-iso'],
    { signal: ctx.signal },
  );
  const logLines = stdout.split('\n').filter(Boolean);
  return {
    success: true,
    output: `Last ${logLines.length} log lines for "${name}"`,
    data: { name, lines: logLines },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const serviceTool: ToolDefinition = {
  name: 'system.service',
  description:
    'Manage systemd services: start, stop, restart, enable, disable, check status, or tail logs.',
  category: 'system',
  requiresConfirmation: true,
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: start | stop | restart | enable | disable | status | logs',
      required: true,
      enum: ['start', 'stop', 'restart', 'enable', 'disable', 'status', 'logs'],
    },
    name: {
      type: 'string',
      description: 'Service name (e.g. nginx, postgresql)',
      required: true,
    },
    lines: {
      type: 'number',
      description: 'Number of log lines to return (logs operation only, default 50)',
      default: 50,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = params['operation'] as string;
    const name = params['name'] as string;
    const lines = typeof params['lines'] === 'number' ? params['lines'] : 50;

    if (!name || typeof name !== 'string') {
      return { success: false, output: 'Service name is required', data: {} };
    }
    // Guard against shell injection via the service name.
    if (!/^[\w@.:/-]+$/.test(name)) {
      return { success: false, output: `Invalid service name: ${name}`, data: {} };
    }

    try {
      switch (operation) {
        case 'start':    return serviceStart(name, ctx);
        case 'stop':     return serviceStop(name, ctx);
        case 'restart':  return serviceRestart(name, ctx);
        case 'enable':   return serviceEnable(name, ctx);
        case 'disable':  return serviceDisable(name, ctx);
        case 'status':   return serviceStatus(name, ctx);
        case 'logs':     return serviceLogs(name, lines, ctx);
        default:
          return { success: false, output: `Unknown operation: ${operation}`, data: {} };
      }
    } catch (err) {
      return handleNotInstalled(err, 'systemctl') as ToolResult;
    }
  },
};
