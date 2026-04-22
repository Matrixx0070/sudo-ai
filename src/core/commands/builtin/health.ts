/**
 * @file builtin/health.ts
 * @description /health — system health check: CPU, memory, disk, key services.
 */

import os from 'os';
import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:health');

function cpuPercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const val of Object.values(cpu.times)) {
      total += val;
    }
    idle += cpu.times.idle;
  }
  return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
}

function statusIcon(ok: boolean): string {
  return ok ? 'OK' : 'WARN';
}

export const healthCommand: SlashCommand = {
  name: 'health',
  description: 'Run a system health check: CPU, memory, disk, services.',
  usage: '/health',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/health executed');

    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const freeMemMb = (freeMem / 1024 / 1024).toFixed(0);
    const totalMemMb = (totalMem / 1024 / 1024).toFixed(0);
    const cpu = cpuPercent();
    const loadAvg = os.loadavg()[0]?.toFixed(2) ?? '?';

    const memOk = memPercent < 90;
    const cpuOk = cpu < 90;

    // Check DB connectivity
    const db = ctx.db as { db?: { prepare: (q: string) => { get: () => unknown } } } | null;
    let dbOk = false;
    try {
      db?.db?.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    // Check tool registry
    const registry = ctx.toolRegistry as { size?: number } | null;
    const toolsOk = (registry?.size ?? 0) > 0;

    const lines = [
      'SYSTEM HEALTH',
      '─────────────',
      `CPU usage:    ${cpu}% load1=${loadAvg}  [${statusIcon(cpuOk)}]`,
      `Memory:       ${memPercent}% used (${freeMemMb}/${totalMemMb} MB free)  [${statusIcon(memOk)}]`,
      `Database:     ${statusIcon(dbOk)}`,
      `Tool registry:${toolsOk ? ` ${registry?.size} tools loaded  [OK]` : '  [WARN: no tools]'}`,
      `Process PID:  ${process.pid}`,
      `Node version: ${process.version}`,
      `Platform:     ${os.platform()} ${os.arch()}`,
    ];

    log.info({ cpu, memPercent, dbOk, toolsOk }, '/health check completed');
    return lines.join('\n');
  },
};
