/**
 * super.profile — Profile commands and URLs for performance bottlenecks.
 *
 * Measures command execution time + memory usage, and for URLs runs
 * multiple HTTP requests to compute average response times.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('super.profile');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandProfile {
  command: string;
  durationMs: number;
  memoryDeltaMB: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface UrlProfile {
  url: string;
  requests: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  failures: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function profileCommand(command: string, signal?: AbortSignal): Promise<CommandProfile> {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0] ?? '';
  const args = parts.slice(1);

  const memBefore = process.memoryUsage().heapUsed;
  const start = Date.now();

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync(bin, args, {
      signal,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    stdout = result.stdout.trim();
    stderr = result.stderr.trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    stdout = (e.stdout ?? '').trim();
    stderr = (e.stderr ?? String(err)).trim();
    exitCode = e.code ?? 1;
  }

  const durationMs = Date.now() - start;
  const memAfter = process.memoryUsage().heapUsed;
  const memoryDeltaMB = (memAfter - memBefore) / 1024 / 1024;

  return { command, durationMs, memoryDeltaMB: parseFloat(memoryDeltaMB.toFixed(2)), exitCode, stdout, stderr };
}

async function profileUrl(url: string, duration: number, signal?: AbortSignal): Promise<UrlProfile> {
  const endAt = Date.now() + duration * 1000;
  const timings: number[] = [];
  let failures = 0;

  while (Date.now() < endAt) {
    if (signal?.aborted) break;
    const start = Date.now();
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) failures++;
      await res.text();
    } catch {
      failures++;
    }
    timings.push(Date.now() - start);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;

  return {
    url,
    requests: timings.length,
    avgMs: parseFloat(avg.toFixed(1)),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p95Ms: percentile(sorted, 95),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const performanceProfilerTool: ToolDefinition = {
  name: 'super.profile',
  description: 'Profile command execution time and memory usage, or load-test a URL and report average/min/max/p95 response times.',
  category: 'superpowers',
  timeout: 120_000,
  parameters: {
    command: { type: 'string', description: 'Shell command to run and measure (e.g. "node script.js").' },
    url: { type: 'string', description: 'HTTP URL to load-test.' },
    duration: { type: 'number', description: 'Load-test duration in seconds.', default: 10 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = params['command'] as string | undefined;
    const url = params['url'] as string | undefined;
    const duration = typeof params['duration'] === 'number' ? params['duration'] : 10;

    if (!command && !url) {
      return { success: false, output: 'Provide either command or url (or both).' };
    }

    logger.info({ session: ctx.sessionId, command, url, duration }, 'Profile started');

    const results: Record<string, unknown> = {};

    try {
      if (command) {
        logger.info({ command }, 'Profiling command');
        const cp = await profileCommand(command, ctx.signal);
        results['command'] = cp;
        logger.info({ command, durationMs: cp.durationMs }, 'Command profiled');
      }

      if (url) {
        logger.info({ url, duration }, 'Profiling URL');
        const up = await profileUrl(url, duration, ctx.signal);
        results['url'] = up;
        logger.info({ url, avgMs: up.avgMs, requests: up.requests }, 'URL profiled');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Profile failed');
      return { success: false, output: `Profile failed: ${msg}` };
    }

    const lines: string[] = ['Performance Profile Results'];

    if (results['command']) {
      const cp = results['command'] as CommandProfile;
      lines.push(`\nCommand: ${cp.command}`);
      lines.push(`  Duration : ${cp.durationMs}ms`);
      lines.push(`  Memory   : ${cp.memoryDeltaMB >= 0 ? '+' : ''}${cp.memoryDeltaMB}MB`);
      lines.push(`  Exit code: ${cp.exitCode}`);
    }

    if (results['url']) {
      const up = results['url'] as UrlProfile;
      lines.push(`\nURL: ${up.url} (${duration}s, ${up.requests} requests)`);
      lines.push(`  Avg  : ${up.avgMs}ms`);
      lines.push(`  Min  : ${up.minMs}ms`);
      lines.push(`  Max  : ${up.maxMs}ms`);
      lines.push(`  p95  : ${up.p95Ms}ms`);
      lines.push(`  Fails: ${up.failures}`);
    }

    return { success: true, output: lines.join('\n'), data: results };
  },
};
