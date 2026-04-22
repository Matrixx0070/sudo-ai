/**
 * @file builtin/status.ts
 * @description /status — agent status, model, tools, sessions, crons, memory, uptime.
 */

import os from 'os';
import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:status');

const START_TIME = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show agent status: model, tools, sessions, crons, memory, uptime.',
  usage: '/status',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/status executed');

    const uptime = formatUptime(Date.now() - START_TIME);
    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const freeMb = (os.freemem() / 1024 / 1024).toFixed(0);
    const totalMb = (os.totalmem() / 1024 / 1024).toFixed(0);

    // Duck-typed reads — tolerate missing properties gracefully
    const registry = ctx.toolRegistry as { size?: number; enabledSize?: number } | null;
    const toolsTotal = registry?.size ?? '?';
    const toolsEnabled = registry?.enabledSize ?? '?';

    // Sessions count via db if available
    const db = ctx.db as {
      db?: { prepare: (q: string) => { get: () => { count: number } | undefined } };
    } | null;

    let sessionsActive = '?';
    try {
      const row = db?.db?.prepare(
        `SELECT COUNT(*) as count FROM chunks WHERE path LIKE 'session:%:meta'`,
      ).get();
      sessionsActive = String(row?.count ?? '?');
    } catch {
      // non-fatal
    }

    const lines = [
      'SUDO-AI STATUS',
      '──────────────',
      `Agent:    online`,
      `Uptime:   ${uptime}`,
      `Process mem: ${memMb} MB RSS`,
      `System mem:  ${freeMb} MB free / ${totalMb} MB total`,
      `Tools:    ${toolsEnabled} enabled / ${toolsTotal} total`,
      `Sessions: ${sessionsActive} stored`,
      `Session:  ${ctx.sessionId}`,
      `Channel:  ${ctx.channel}`,
    ];

    return lines.join('\n');
  },
};
