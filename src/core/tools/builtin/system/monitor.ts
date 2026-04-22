/**
 * system.monitor — Real-time system metrics read directly from /proc.
 * Read-only: no requiresConfirmation, no shell commands for metrics.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from './exec.js';

const logger = createLogger('system.monitor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CpuStats { user: number; nice: number; system: number; idle: number; usagePercent: number }
interface MemStats { totalKb: number; freeKb: number; availableKb: number; usedKb: number; usedPercent: number }
interface DiskStats { device: string; readsCompleted: number; writesCompleted: number; readSectors: number; writeSectors: number }
interface NetStats { iface: string; rxBytes: number; txBytes: number; rxPackets: number; txPackets: number }
interface SystemSnapshot { cpu: CpuStats; memory: MemStats; disks: DiskStats[]; network: NetStats[]; timestamp: string }
interface TopProcess { pid: number; name: string; cpu: number; mem: number }

// ---------------------------------------------------------------------------
// /proc readers
// ---------------------------------------------------------------------------

async function readProcFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function getCpuStats(): Promise<CpuStats> {
  const content = await readProcFile('/proc/stat');
  const line = content.split('\n').find((l) => l.startsWith('cpu ')) ?? '';
  const parts = line.split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0] = parts;
  const total = parts.reduce((a, b) => a + b, 0);
  const usagePercent = total > 0 ? parseFloat((((total - idle) / total) * 100).toFixed(2)) : 0;
  return { user, nice, system, idle, usagePercent };
}

async function getMemStats(): Promise<MemStats> {
  const content = await readProcFile('/proc/meminfo');
  const extract = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(content);
    return m ? parseInt(m[1] ?? '0', 10) : 0;
  };
  const totalKb = extract('MemTotal');
  const freeKb = extract('MemFree');
  const availableKb = extract('MemAvailable');
  const usedKb = totalKb - freeKb;
  const usedPercent = totalKb > 0 ? parseFloat(((usedKb / totalKb) * 100).toFixed(2)) : 0;
  return { totalKb, freeKb, availableKb, usedKb, usedPercent };
}

async function getDiskStats(): Promise<DiskStats[]> {
  const content = await readProcFile('/proc/diskstats');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const device = parts[2] ?? '';
      // Skip partition entries (e.g. sda1) — keep only whole-disk devices.
      if (/\d$/.test(device) && !/^nvme/.test(device)) return null;
      return {
        device,
        readsCompleted: parseInt(parts[3] ?? '0', 10),
        readSectors: parseInt(parts[5] ?? '0', 10),
        writesCompleted: parseInt(parts[7] ?? '0', 10),
        writeSectors: parseInt(parts[9] ?? '0', 10),
      };
    })
    .filter((d): d is DiskStats => d !== null && d.device !== '')
    .slice(0, 10);
}

async function getNetStats(): Promise<NetStats[]> {
  const content = await readProcFile('/proc/net/dev');
  return content
    .split('\n')
    .slice(2) // skip header lines
    .filter(Boolean)
    .map((line) => {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) return null;
      const iface = line.slice(0, colonIdx).trim();
      const nums = line.slice(colonIdx + 1).trim().split(/\s+/).map(Number);
      return {
        iface,
        rxBytes: nums[0] ?? 0,
        rxPackets: nums[1] ?? 0,
        txBytes: nums[8] ?? 0,
        txPackets: nums[9] ?? 0,
      };
    })
    .filter((n): n is NetStats => n !== null && n.iface !== 'lo');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function snapshot(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Taking system snapshot');
  const [cpu, memory, disks, network] = await Promise.all([
    getCpuStats(),
    getMemStats(),
    getDiskStats(),
    getNetStats(),
  ]);
  const data: SystemSnapshot = { cpu, memory, disks, network, timestamp: new Date().toISOString() };
  const memGb = (memory.usedKb / 1024 / 1024).toFixed(2);
  const totalGb = (memory.totalKb / 1024 / 1024).toFixed(2);
  return {
    success: true,
    output: `CPU: ${cpu.usagePercent}% | MEM: ${memGb}/${totalGb} GB (${memory.usedPercent}%) | ${network.length} interfaces`,
    data,
  };
}

async function topProcesses(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Getting top processes');
  const { stdout } = await runCmd(
    'ps',
    ['aux', '--no-headers', '--sort=-%cpu'],
    { signal: ctx.signal },
  );
  const processes: TopProcess[] = stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const p = line.trim().split(/\s+/);
      return {
        pid: parseInt(p[1] ?? '0', 10),
        name: p.slice(10).join(' ').slice(0, 60),
        cpu: parseFloat(p[2] ?? '0'),
        mem: parseFloat(p[3] ?? '0'),
      };
    });
  return {
    success: true,
    output: `Top ${processes.length} processes by CPU`,
    data: { processes },
  };
}

async function uptime(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Reading uptime');
  const content = await readProcFile('/proc/uptime');
  const seconds = parseFloat(content.split(' ')[0] ?? '0');
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const formatted = `${days}d ${hours}h ${minutes}m`;
  return { success: true, output: `Uptime: ${formatted}`, data: { seconds, formatted } };
}

async function loadAverage(ctx: ToolContext): Promise<ToolResult> {
  logger.info({ session: ctx.sessionId }, 'Reading load average');
  const content = await readProcFile('/proc/loadavg');
  const parts = content.trim().split(/\s+/);
  const data = {
    load1: parseFloat(parts[0] ?? '0'),
    load5: parseFloat(parts[1] ?? '0'),
    load15: parseFloat(parts[2] ?? '0'),
    runningThreads: parseInt((parts[3] ?? '0/0').split('/')[0] ?? '0', 10),
    totalThreads: parseInt((parts[3] ?? '0/0').split('/')[1] ?? '0', 10),
    lastPid: parseInt(parts[4] ?? '0', 10),
  };
  return {
    success: true,
    output: `Load: ${data.load1} (1m) ${data.load5} (5m) ${data.load15} (15m)`,
    data,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const monitorTool: ToolDefinition = {
  name: 'system.monitor',
  description: 'Read real-time system metrics: CPU/memory/disk/network snapshot, top processes, uptime, load average.',
  category: 'system',
  requiresConfirmation: false,
  timeout: 15_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Operation: snapshot | top-processes | uptime | load-average',
      required: true,
      enum: ['snapshot', 'top-processes', 'uptime', 'load-average'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const op = params['operation'] as string;
    switch (op) {
      case 'snapshot':       return snapshot(ctx);
      case 'top-processes':  return topProcesses(ctx);
      case 'uptime':         return uptime(ctx);
      case 'load-average':   return loadAverage(ctx);
      default:
        return { success: false, output: `Unknown operation: ${op}`, data: {} };
    }
  },
};
