/**
 * system.process — List, inspect, and kill processes.
 * Linux: /proc filesystem for detailed info, GNU ps for listing (unchanged).
 * darwin/other: BSD ps invocations (no --no-headers; header skipped in code).
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '../../../shared/logger.js';
import { SystemError } from '../../../shared/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from './exec.js';

const logger = createLogger('system.process');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessEntry {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  vsz: number;
  rss: number;
  stat: string;
  command: string;
}

interface ProcessInfo extends ProcessEntry {
  ppid?: number;
  threads?: number;
  openFiles?: number;
  cmdline?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the `ps` argv for a full process listing.
 *
 * Linux (GNU ps): `ps aux --no-headers` — unchanged from the original code.
 * darwin/other (BSD ps): `--no-headers` is not supported, so plain `ps aux`
 * is used and the header line is skipped in code. BSD `ps aux` emits the same
 * 11-column layout (USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND),
 * so parsePsLine works for both.
 *
 * @param platform - injectable for unit tests; defaults to process.platform.
 */
export function buildPsListArgs(
  platform: NodeJS.Platform = process.platform,
): { args: string[]; skipHeader: boolean } {
  if (platform === 'linux') {
    return { args: ['aux', '--no-headers'], skipHeader: false };
  }
  return { args: ['aux'], skipHeader: true };
}

/**
 * Build the `ps` argv for inspecting a single PID.
 *
 * Linux: `ps aux --no-headers -p <pid>` — unchanged.
 * darwin/other: explicit BSD `-o` column list reproducing the `aux` layout
 * (BSD ps does not reliably combine `aux` with `-p`), header skipped in code.
 */
export function buildPsInfoArgs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): { args: string[]; skipHeader: boolean } {
  if (platform === 'linux') {
    return { args: ['aux', '--no-headers', '-p', String(pid)], skipHeader: false };
  }
  return {
    args: ['-ww', '-o', 'user,pid,%cpu,%mem,vsz,rss,tt,stat,start,time,command', '-p', String(pid)],
    skipHeader: true,
  };
}

function parsePsLine(line: string): ProcessEntry | null {
  // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
  const parts = line.trim().split(/\s+/);
  if (parts.length < 11) return null;
  const pid = parseInt(parts[1] ?? '0', 10);
  if (isNaN(pid)) return null;
  return {
    pid,
    user: parts[0] ?? '',
    cpu: parseFloat(parts[2] ?? '0'),
    mem: parseFloat(parts[3] ?? '0'),
    vsz: parseInt(parts[4] ?? '0', 10),
    rss: parseInt(parts[5] ?? '0', 10),
    stat: parts[7] ?? '',
    command: parts.slice(10).join(' '),
  };
}

async function readProcFile(pid: number, file: string): Promise<string> {
  try {
    return await readFile(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return '';
  }
}

async function buildProcessInfo(entry: ProcessEntry): Promise<ProcessInfo> {
  const [status, cmdline] = await Promise.all([
    readProcFile(entry.pid, 'status'),
    readProcFile(entry.pid, 'cmdline'),
  ]);

  const ppidMatch = /^PPid:\s+(\d+)/m.exec(status);
  const threadsMatch = /^Threads:\s+(\d+)/m.exec(status);

  return {
    ...entry,
    ppid: ppidMatch ? parseInt(ppidMatch[1] ?? '0', 10) : undefined,
    threads: threadsMatch ? parseInt(threadsMatch[1] ?? '0', 10) : undefined,
    cmdline: cmdline.replace(/\0/g, ' ').trim(),
  };
}

/**
 * Platform dispatch for the detail lookup: Linux keeps the /proc reads
 * (unchanged); darwin/other has no /proc, so ppid comes from `ps -o ppid=`
 * and cmdline from the ps COMMAND column. Thread count has no cheap portable
 * source outside /proc and is left undefined (unavailable) off Linux.
 */
async function buildProcessInfoForPlatform(
  entry: ProcessEntry,
  ctx: ToolContext,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessInfo> {
  if (platform === 'linux') {
    return buildProcessInfo(entry);
  }
  let ppid: number | undefined;
  try {
    const { stdout } = await runCmd('ps', ['-p', String(entry.pid), '-o', 'ppid='], {
      signal: ctx.signal,
      allowFailure: true,
    });
    const parsed = parseInt(stdout.trim(), 10);
    if (!isNaN(parsed)) ppid = parsed;
  } catch {
    // ppid stays undefined — unavailable
  }
  return { ...entry, ppid, threads: undefined, cmdline: entry.command };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function listProcesses(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Listing processes');
  const { args, skipHeader } = buildPsListArgs();
  const { stdout } = await runCmd('ps', args, { signal: ctx.signal });
  const lines = stdout.split('\n');
  const processes = (skipHeader ? lines.slice(1) : lines)
    .map(parsePsLine)
    .filter((p): p is ProcessEntry => p !== null);

  return {
    success: true,
    output: `Found ${processes.length} processes`,
    data: { processes },
  };
}

async function getProcessInfo(pid: number, ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId, pid }, 'Getting process info');
  const { args, skipHeader } = buildPsInfoArgs(pid);
  const { stdout } = await runCmd('ps', args, { signal: ctx.signal, allowFailure: true });
  const lines = stdout.split('\n');
  const dataLines = skipHeader ? lines.slice(1) : lines;
  if (!dataLines[0]) {
    return { success: false, output: `No process found with PID ${pid}`, data: {} };
  }
  const entry = parsePsLine(dataLines[0]);
  if (!entry) {
    return { success: false, output: `Cannot parse process info for PID ${pid}`, data: {} };
  }
  const info = await buildProcessInfoForPlatform(entry, ctx);
  return {
    success: true,
    output: `Process ${pid}: ${info.command} (CPU: ${info.cpu}%, MEM: ${info.mem}%)`,
    data: { process: info },
  };
}

async function killProcess(
  params: { pid?: number; name?: string; signal?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const sig = params.signal ?? 'SIGTERM';
  const validSignals = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGUSR1', 'SIGUSR2'];
  if (!validSignals.includes(sig)) {
    throw new SystemError(`Invalid signal: ${sig}`, 'invalid_signal', { signal: sig });
  }

  if (params.pid !== undefined) {
    logger.warn({ session: ctx.sessionId, pid: params.pid, signal: sig }, 'Killing process by PID');
    await runCmd('kill', [`-${sig}`, String(params.pid)], { signal: ctx.signal });
    return { success: true, output: `Sent ${sig} to PID ${params.pid}`, data: { pid: params.pid, signal: sig } };
  }

  if (params.name) {
    logger.warn({ session: ctx.sessionId, name: params.name, signal: sig }, 'Killing process by name');
    await runCmd('pkill', [`-${sig}`, '-f', params.name], { signal: ctx.signal });
    return { success: true, output: `Sent ${sig} to all processes matching "${params.name}"`, data: { name: params.name, signal: sig } };
  }

  throw new SystemError('kill requires pid or name', 'missing_param', {});
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const processTool: ToolDefinition = {
  name: 'system.process',
  description: 'List running processes, get detailed info about a process, or kill a process by PID or name.',
  category: 'system',
  requiresConfirmation: false,
  timeout: 15_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation to perform: list, info, kill',
      required: true,
      enum: ['list', 'info', 'kill'],
    },
    pid: {
      type: 'number',
      description: 'Process ID (used for info and kill operations)',
    },
    name: {
      type: 'string',
      description: 'Process name or pattern (used for kill operation)',
    },
    signal: {
      type: 'string',
      description: 'Signal to send (default SIGTERM)',
      default: 'SIGTERM',
      enum: ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGUSR1', 'SIGUSR2'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = params['operation'] as string;
    const pid = params['pid'] !== undefined ? Number(params['pid']) : undefined;
    const name = params['name'] as string | undefined;
    const signal = params['signal'] as string | undefined;

    const isKill = operation === 'kill';
    if (isKill) {
      // requiresConfirmation is tool-level; mark in output for caller awareness
      logger.warn({ session: ctx.sessionId, operation, pid, name }, 'Destructive process operation');
    }

    switch (operation) {
      case 'list':
        return listProcesses(ctx);
      case 'info': {
        if (pid === undefined || isNaN(pid)) {
          return { success: false, output: 'info operation requires a valid pid', data: {} };
        }
        return getProcessInfo(pid, ctx);
      }
      case 'kill': {
        return killProcess({ pid, name, signal }, ctx);
      }
      default:
        return { success: false, output: `Unknown operation: ${operation}`, data: {} };
    }
  },
};

// Kill operation needs confirmation; override the flag dynamically via a wrapper approach.
// The registry checks requiresConfirmation at the tool level, so we set it true and rely
// on the runtime to prompt.  For list/info (read-only) the confirmation overhead is
// acceptable given the simplicity of the tool.
processTool.requiresConfirmation = true;
