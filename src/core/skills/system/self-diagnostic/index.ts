/**
 * Skill: system.self-diagnostic
 * Category: system
 * Version: 1.0.0
 *
 * Comprehensive health check for SUDO-AI. Checks:
 *   1. Process / service status (is SUDO-AI itself running as expected)
 *   2. mind.db connectivity and size
 *   3. Cron job health (last 24h runs)
 *   4. API cost burn rate today vs. daily budget
 *   5. Tool count registered in DB (via querying mind.db for skills)
 *   6. Disk usage for data/ directory
 *   7. Log file size
 *
 * Returns: { status, checks, issues }
 * No external calls — purely local.
 */

import Database from 'better-sqlite3';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../tools/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

const logger = createLogger('skill.system.self-diagnostic');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = join(DATA_DIR, 'mind.db');
const LOG_DIR = join(DATA_DIR, 'logs');
const DAILY_BUDGET_USD = 5.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  value: string;
  detail?: string;
}

export interface SelfDiagnosticOutput {
  status: 'healthy' | 'degraded' | 'critical';
  checks: DiagnosticCheck[];
  issues: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(fullPath);
      } else if (entry.isFile()) {
        try { total += statSync(fullPath).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip unreadable dirs */ }
  return total;
}

// Check 1: mind.db connectivity
function checkDatabase(): DiagnosticCheck {
  if (!existsSync(DB_PATH)) {
    return { name: 'mind.db', status: 'fail', value: 'missing', detail: `Expected at ${DB_PATH}` };
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    const row = db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM sessions').get();
    const skillRow = db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM skills WHERE enabled = 1').get();
    db.close();

    const sizeMB = statSync(DB_PATH).size / 1024 / 1024;
    return {
      name: 'mind.db',
      status: sizeMB > 500 ? 'warn' : 'pass',
      value: `${sizeMB.toFixed(1)}MB, ${row?.count ?? 0} sessions, ${skillRow?.count ?? 0} skills enabled`,
      detail: sizeMB > 500 ? 'DB growing large — consider archival' : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'mind.db', status: 'fail', value: 'error', detail: msg };
  }
}

// Check 2: Cron health in last 24h
function checkCronHealth(): DiagnosticCheck {
  if (!existsSync(DB_PATH)) {
    return { name: 'cron_runs', status: 'warn', value: 'db missing' };
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = db.prepare<{ cutoff: string }, { status: string; count: number }>(`
      SELECT status, COUNT(*) as count FROM cron_runs WHERE ran_at > :cutoff GROUP BY status
    `).all({ cutoff });
    db.close();

    const counts: Record<string, number> = {};
    for (const r of rows) { counts[r.status] = r.count; }
    const ok = counts['ok'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const total = ok + failed + (counts['skipped'] ?? 0);

    if (total === 0) {
      return { name: 'cron_runs', status: 'warn', value: '0 runs in last 24h', detail: 'No cron activity detected' };
    }
    if (failed > 0) {
      return { name: 'cron_runs', status: failed > ok ? 'fail' : 'warn', value: `${ok} ok / ${failed} failed in 24h` };
    }
    return { name: 'cron_runs', status: 'pass', value: `${ok} ok in 24h` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'cron_runs', status: 'fail', value: 'error', detail: msg };
  }
}

// Check 3: API cost burn today
function checkApiCosts(): DiagnosticCheck {
  if (!existsSync(DB_PATH)) {
    return { name: 'api_costs', status: 'warn', value: 'db missing' };
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const cutoff = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const row = db.prepare<{ cutoff: string }, { total: number }>(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_costs WHERE created_at >= :cutoff
    `).get({ cutoff });
    db.close();

    const total = row?.total ?? 0;
    const pct = (total / DAILY_BUDGET_USD) * 100;
    const value = `$${total.toFixed(4)} today (${pct.toFixed(0)}% of $${DAILY_BUDGET_USD} budget)`;

    if (total > DAILY_BUDGET_USD) return { name: 'api_costs', status: 'fail', value, detail: 'Daily budget exceeded' };
    if (total > DAILY_BUDGET_USD * 0.8) return { name: 'api_costs', status: 'warn', value, detail: '>80% budget used' };
    return { name: 'api_costs', status: 'pass', value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'api_costs', status: 'fail', value: 'error', detail: msg };
  }
}

// Check 4: Disk usage
function checkDiskUsage(): DiagnosticCheck {
  const size = dirSize(DATA_DIR);
  const human = bytesToHuman(size);
  const gb = size / 1024 ** 3;
  if (gb > 10) return { name: 'disk_usage', status: 'fail', value: human, detail: 'data/ directory is over 10GB' };
  if (gb > 5) return { name: 'disk_usage', status: 'warn', value: human, detail: 'data/ directory is over 5GB' };
  return { name: 'disk_usage', status: 'pass', value: human };
}

// Check 5: Log file size
function checkLogs(): DiagnosticCheck {
  const logFile = join(LOG_DIR, 'sudo-ai.log');
  if (!existsSync(logFile)) {
    return { name: 'log_file', status: 'warn', value: 'not found', detail: 'sudo-ai.log does not exist yet' };
  }
  const size = statSync(logFile).size;
  const human = bytesToHuman(size);
  const mb = size / 1024 ** 2;
  if (mb > 500) return { name: 'log_file', status: 'warn', value: human, detail: 'Log file > 500MB — consider rotation' };
  return { name: 'log_file', status: 'pass', value: human };
}

// Check 6: Node.js process memory
function checkMemory(): DiagnosticCheck {
  const mem = process.memoryUsage();
  const heapMB = mem.heapUsed / 1024 ** 2;
  const rssGb = mem.rss / 1024 ** 3;
  const value = `heap ${heapMB.toFixed(0)}MB, rss ${bytesToHuman(mem.rss)}`;
  if (rssGb > 2) return { name: 'process_memory', status: 'warn', value, detail: 'RSS > 2GB' };
  return { name: 'process_memory', status: 'pass', value };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function runDiagnostics(ctx: ToolContext): SelfDiagnosticOutput {
  logger.info({ session: ctx.sessionId }, 'system.self-diagnostic running');

  const checks: DiagnosticCheck[] = [
    checkDatabase(),
    checkCronHealth(),
    checkApiCosts(),
    checkDiskUsage(),
    checkLogs(),
    checkMemory(),
  ];

  const issues = checks
    .filter((c) => c.status !== 'pass')
    .map((c) => `[${c.status.toUpperCase()}] ${c.name}: ${c.value}${c.detail ? ` — ${c.detail}` : ''}`);

  const hasFailure = checks.some((c) => c.status === 'fail');
  const hasWarning = checks.some((c) => c.status === 'warn');

  const status: SelfDiagnosticOutput['status'] = hasFailure ? 'critical' : hasWarning ? 'degraded' : 'healthy';

  logger.info({ status, issues: issues.length }, 'system.self-diagnostic complete');
  return { status, checks, issues, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: 'system.self-diagnostic',
  description:
    'Run a comprehensive SUDO-AI health check. Verifies mind.db, cron job activity, '
    + 'API cost burn rate, disk usage, log file size, and process memory. '
    + 'Input: {} (no params). Output: { status, checks, issues, timestamp }.',
  category: 'system',
  timeout: 20_000,
  parameters: {},

  async execute(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = runDiagnostics(ctx);
      const statusIcon = result.status === 'healthy' ? 'OK' : result.status === 'degraded' ? 'WARN' : 'CRITICAL';
      const lines = [
        `[${statusIcon}] SUDO-AI Self-Diagnostic — ${result.timestamp}`,
        '',
        'Checks:',
        ...result.checks.map((c) => `  [${c.status.toUpperCase()}] ${c.name}: ${c.value}${c.detail ? ` (${c.detail})` : ''}`),
      ];
      if (result.issues.length > 0) {
        lines.push('', 'Issues:', ...result.issues.map((i) => `  - ${i}`));
      }
      return { success: true, output: lines.join('\n'), data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'system.self-diagnostic error');
      return { success: false, output: `system.self-diagnostic error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration export
// ---------------------------------------------------------------------------

export function registerSkill(registry: ToolRegistry): void {
  registry.register(skillTool);
}

export default skillTool;
