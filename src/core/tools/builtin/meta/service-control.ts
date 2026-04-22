/**
 * meta.service-control — SUDO-AI systemd service management tool.
 *
 * Allows the brain to inspect and control its own systemd service lifecycle.
 *
 * Actions:
 *   status        — Parse `systemctl status sudo-ai` (active state, uptime, memory, CPU)
 *   restart       — Graceful restart via `systemctl restart sudo-ai`
 *   stop          — Stop the service (logs warning — may be needed for updates)
 *   start         — Start the service via `systemctl start sudo-ai`
 *   logs          — Fetch recent journal entries for the service
 *   reload-config — Emit process event to hot-reload configuration
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const logger = createLogger('meta.service-control');
const SERVICE_NAME = 'sudo-ai';
const DATA_DIR = path.resolve('data');
const EVENTS_LOG = path.join(DATA_DIR, 'service-events.log');
const RESTART_MARKER = path.join(DATA_DIR, 'restart-scheduled.marker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function logEvent(action: string, reason?: string): void {
  ensureDataDir();
  const entry = `[${timestamp()}] action=${action}${reason ? ` reason="${reason}"` : ''}\n`;
  appendFileSync(EVENTS_LOG, entry, 'utf-8');
  logger.info({ action, reason }, `service-control: ${action}`);
}

function runCmd(cmd: string, timeoutMs = 15_000): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ---------------------------------------------------------------------------
// Status parser
// ---------------------------------------------------------------------------

interface ServiceStatus {
  activeState: string;
  subState: string;
  pid?: number;
  uptime?: string;
  memory?: string;
  cpu?: string;
  tasks?: string;
}

function parseStatus(raw: string): ServiceStatus {
  const activeMatch = raw.match(/Active:\s*(\S+)\s*\((\S+)\)/);
  const pidMatch = raw.match(/Main PID:\s*(\d+)/);
  const sinceMatch = raw.match(/Active:.*?;\s*(.+?)$/m);
  const memMatch = raw.match(/Memory:\s*(.+?)$/m);
  const cpuMatch = raw.match(/CPU:\s*(.+?)$/m);
  const tasksMatch = raw.match(/Tasks:\s*(.+?)$/m);

  return {
    activeState: activeMatch?.[1] ?? 'unknown',
    subState: activeMatch?.[2] ?? 'unknown',
    pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
    uptime: sinceMatch?.[1]?.trim(),
    memory: memMatch?.[1]?.trim(),
    cpu: cpuMatch?.[1]?.trim(),
    tasks: tasksMatch?.[1]?.trim(),
  };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleStatus(): Promise<ToolResult> {
  try {
    const raw = runCmd(`systemctl status ${SERVICE_NAME} 2>&1 || true`);
    const status = parseStatus(raw);
    logEvent('status');

    const lines = [
      `Service: ${SERVICE_NAME}`,
      `State: ${status.activeState} (${status.subState})`,
    ];
    if (status.pid) lines.push(`PID: ${status.pid}`);
    if (status.uptime) lines.push(`Uptime: ${status.uptime}`);
    if (status.memory) lines.push(`Memory: ${status.memory}`);
    if (status.cpu) lines.push(`CPU: ${status.cpu}`);
    if (status.tasks) lines.push(`Tasks: ${status.tasks}`);

    return {
      success: true,
      output: lines.join('\n'),
      data: status,
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to get service status: ${String(err)}`,
    };
  }
}

async function handleRestart(reason?: string): Promise<ToolResult> {
  try {
    logEvent('restart', reason ?? 'no reason provided');

    // Write restart marker so the new process knows this was intentional
    ensureDataDir();
    writeFileSync(RESTART_MARKER, JSON.stringify({
      scheduledAt: timestamp(),
      reason: reason ?? 'no reason provided',
    }), 'utf-8');

    runCmd(`systemctl restart ${SERVICE_NAME}`, 30_000);

    return {
      success: true,
      output: `Service ${SERVICE_NAME} restart initiated.${reason ? ` Reason: ${reason}` : ''}`,
      data: { action: 'restart', reason },
      artifacts: [
        { path: RESTART_MARKER, action: 'created' },
        { path: EVENTS_LOG, action: 'modified' },
      ],
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to restart service: ${String(err)}`,
    };
  }
}

async function handleStop(reason?: string): Promise<ToolResult> {
  logger.warn({ reason }, 'WARNING: Stopping SUDO-AI service. This will terminate the current process.');

  try {
    logEvent('stop', reason ?? 'no reason provided');

    runCmd(`systemctl stop ${SERVICE_NAME}`, 30_000);

    return {
      success: true,
      output: `WARNING: Service ${SERVICE_NAME} has been stopped.${reason ? ` Reason: ${reason}` : ''}`,
      data: { action: 'stop', reason },
      artifacts: [{ path: EVENTS_LOG, action: 'modified' }],
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to stop service: ${String(err)}`,
    };
  }
}

async function handleStart(reason?: string): Promise<ToolResult> {
  try {
    logEvent('start', reason ?? 'manual start');

    runCmd(`systemctl start ${SERVICE_NAME}`, 30_000);

    return {
      success: true,
      output: `Service ${SERVICE_NAME} started successfully.`,
      data: { action: 'start' },
      artifacts: [{ path: EVENTS_LOG, action: 'modified' }],
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to start service: ${String(err)}`,
    };
  }
}

async function handleLogs(lines: number): Promise<ToolResult> {
  try {
    logEvent('logs');
    const output = runCmd(`journalctl -u ${SERVICE_NAME} --no-pager -n ${lines}`, 10_000);

    return {
      success: true,
      output: output || '(no log entries found)',
      data: { lines, length: output.length },
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to fetch logs: ${String(err)}`,
    };
  }
}

async function handleReloadConfig(): Promise<ToolResult> {
  try {
    logEvent('reload-config');

    // Emit a process-level event that config watchers can listen to
    process.emit('message' as any, { type: 'reload-config', timestamp: timestamp() } as any, undefined as any);

    return {
      success: true,
      output: 'Configuration reload event emitted. Listeners will pick up new config without restart.',
      data: { action: 'reload-config' },
    };
  } catch (err) {
    return {
      success: false,
      output: `Failed to emit reload event: ${String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const serviceControlTool: ToolDefinition = {
  name: 'meta.service-control',
  description:
    'Control the SUDO-AI systemd service. Check status, restart, stop, start, view logs, or hot-reload configuration. ' +
    'Use this to manage the service lifecycle, diagnose issues via logs, or perform graceful restarts for updates.',
  category: 'meta',
  parameters: {
    action: {
      type: 'string',
      description: 'The service control action to perform.',
      required: true,
      enum: ['status', 'restart', 'stop', 'start', 'logs', 'reload-config'],
    },
    reason: {
      type: 'string',
      description: 'Why this action is being performed. Logged for audit purposes. Recommended for restart/stop.',
      required: false,
    },
    lines: {
      type: 'number',
      description: 'Number of journal log lines to retrieve (only used with "logs" action).',
      required: false,
      default: 50,
    },
  },
  timeout: 60_000,

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    const reason = params['reason'] as string | undefined;
    const lines = (params['lines'] as number) ?? 50;

    switch (action) {
      case 'status':
        return handleStatus();
      case 'restart':
        return handleRestart(reason);
      case 'stop':
        return handleStop(reason);
      case 'start':
        return handleStart(reason);
      case 'logs':
        return handleLogs(lines);
      case 'reload-config':
        return handleReloadConfig();
      default:
        return {
          success: false,
          output: `Unknown action "${action}". Valid actions: status, restart, stop, start, logs, reload-config.`,
        };
    }
  },
};
