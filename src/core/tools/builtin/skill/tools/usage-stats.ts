/**
 * @file skill/tools/usage-stats.ts
 * @description skill.usage-stats — aggregates per-tool call statistics from
 * audit.db and calibration.db, giving SUDO a view of how its tools perform.
 *
 * All DB access is read-only. Fails open: returns empty/zero stats when DB
 * files are missing or queries return nothing.
 */

import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import { DATA_DIR } from '../../../../shared/paths.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';

const logger = createLogger('skill:usage-stats');

// ---------------------------------------------------------------------------
// DB helpers — duck-typed to avoid importing better-sqlite3 types directly
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}

type DbConstructorFn = new (path: string, opts?: Record<string, unknown>) => DbLike;

function openReadonly(dbPath: string): DbLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ctor = require('better-sqlite3') as DbConstructorFn;
    return new Ctor(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stat types
// ---------------------------------------------------------------------------

export interface ToolUsageStat {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  vetoCount: number;
  avgDurationMs: number;
  successRate: number;
  brierForTool: number | null;
  topErrorKinds: string[];
}

// ---------------------------------------------------------------------------
// Internal query helpers
// ---------------------------------------------------------------------------

interface AuditRow {
  resource: string;
  outcome: string;
  metadata_json: string | null;
}

interface CalibRow {
  tag: string | null;
  predicted: number;
  outcome: number;
}

const AUDIT_DB = path.join(DATA_DIR, 'audit.db');
const CALIBRATION_DB = path.join(DATA_DIR, 'calibration.db');

/** Aggregate raw audit rows into per-tool stats map. */
function aggregateAuditRows(rows: AuditRow[]): Map<string, Omit<ToolUsageStat, 'brierForTool'>> {
  const map = new Map<string, Omit<ToolUsageStat, 'brierForTool'>>();
  // Count of rows that actually contributed a durationMs sample, per tool.
  // Used as the running-average weight so rows lacking durationMs don't skew it.
  const durationSamples = new Map<string, number>();

  for (const row of rows) {
    const key = row.resource || 'unknown';
    let entry = map.get(key);
    if (!entry) {
      entry = { toolName: key, totalCalls: 0, successCount: 0, failureCount: 0, vetoCount: 0, avgDurationMs: 0, successRate: 0, topErrorKinds: [] };
      map.set(key, entry);
    }
    entry.totalCalls++;
    const outcome = row.outcome?.toLowerCase() ?? '';
    if (outcome === 'success') {
      entry.successCount++;
    } else if (outcome === 'veto' || outcome === 'blocked') {
      entry.vetoCount++;
    } else {
      entry.failureCount++;
    }

    // Extract durationMs and errorKind from metadata_json
    if (row.metadata_json) {
      try {
        const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
        const dur = meta['durationMs'];
        if (typeof dur === 'number' && dur > 0) {
          // Running average weighted by the number of duration samples seen so
          // far for this tool (not totalCalls, since not every row has a duration).
          const n = (durationSamples.get(key) ?? 0) + 1;
          durationSamples.set(key, n);
          // Running average: (prev_avg * (n-1) + new) / n
          entry.avgDurationMs = (entry.avgDurationMs * (n - 1) + dur) / n;
        }
        const ek = meta['errorKind'] ?? meta['error_kind'];
        if (typeof ek === 'string' && ek.length > 0 && outcome !== 'success') {
          if (!entry.topErrorKinds.includes(ek)) {
            entry.topErrorKinds.push(ek);
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  // Finalise successRate
  for (const entry of map.values()) {
    entry.successRate = entry.totalCalls > 0 ? entry.successCount / entry.totalCalls : 0;
  }

  return map;
}

/** Query calibration DB for Brier score per tool (matched by tag LIKE toolName). */
function brierForTool(calibDb: DbLike, toolName: string): number | null {
  try {
    const rows = calibDb.prepare(
      `SELECT predicted, outcome FROM confidence_calibration WHERE tag LIKE ? ORDER BY ts DESC LIMIT 100`
    ).all(`%${toolName}%`) as CalibRow[];
    if (rows.length === 0) return null;
    const sum = rows.reduce((acc, r) => acc + (r.predicted - r.outcome) ** 2, 0);
    return Math.round((sum / rows.length) * 1000) / 1000;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core function (exported for use by skill.explain)
// ---------------------------------------------------------------------------

export async function getUsageStats(
  toolNameFilter: string | undefined,
  windowDays: number,
): Promise<ToolUsageStat[]> {
  const since = Date.now() - windowDays * 86_400_000;
  const sinceIso = new Date(since).toISOString();

  const auditDb = openReadonly(AUDIT_DB);
  const calibDb = openReadonly(CALIBRATION_DB);

  let rows: AuditRow[] = [];
  if (auditDb) {
    try {
      rows = auditDb.prepare(
        `SELECT resource, outcome, metadata_json FROM audit_log
         WHERE action = 'tool_call' AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT 2000`
      ).all(sinceIso) as AuditRow[];
    } catch {
      logger.warn({ sinceIso }, 'skill.usage-stats: audit_log query failed, returning empty');
    } finally {
      try { auditDb.close(); } catch { /* ignore */ }
    }
  }

  const statsMap = aggregateAuditRows(rows);

  // Attach Brier scores if calibration DB available
  if (calibDb) {
    for (const [key, entry] of statsMap.entries()) {
      const brier = brierForTool(calibDb, key);
      (entry as ToolUsageStat).brierForTool = brier;
    }
    try { calibDb.close(); } catch { /* ignore */ }
  } else {
    for (const entry of statsMap.values()) {
      (entry as ToolUsageStat).brierForTool = null;
    }
  }

  let results = [...statsMap.values()] as ToolUsageStat[];

  // Filter by toolName if provided
  if (toolNameFilter) {
    results = results.filter(s => s.toolName.includes(toolNameFilter));
  }

  // Sort by totalCalls desc, cap at 20
  results.sort((a, b) => b.totalCalls - a.totalCalls);
  return results.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const usageStatsTool: ToolDefinition = {
  name: 'skill.usage-stats',
  description:
    'Aggregate per-tool call statistics (total calls, success/failure rates, veto count, avg duration, Brier score) from audit and calibration databases. Lets SUDO reflect on how each of its tools performs.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    toolName: {
      type: 'string',
      description: 'Filter to a specific tool name (substring match). Omit to get top-20 tools by call volume.',
    },
    windowDays: {
      type: 'number',
      description: 'Look-back window in days (default: 7).',
      default: 7,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const toolName = params['toolName'] as string | undefined;
    const windowDays = Math.max(1, Math.min(365, (params['windowDays'] as number | undefined) ?? 7));

    logger.info({ session: ctx.sessionId, toolName, windowDays }, 'skill.usage-stats invoked');

    try {
      const stats = await getUsageStats(toolName, windowDays);

      if (stats.length === 0) {
        return {
          success: true,
          output: `No tool call records found in the last ${windowDays} day(s)${toolName ? ` for tool "${toolName}"` : ''}.`,
          data: { stats: [], windowDays, toolName },
        };
      }

      const lines = stats.map(s =>
        `  ${s.toolName}: ${s.totalCalls} calls, ${(s.successRate * 100).toFixed(1)}% success, ` +
        `${s.vetoCount} vetoes, avg ${s.avgDurationMs.toFixed(0)}ms` +
        (s.brierForTool !== null ? `, Brier=${s.brierForTool}` : '')
      );

      return {
        success: true,
        output: `Tool usage stats (last ${windowDays}d):\n${lines.join('\n')}`,
        data: { stats, windowDays, toolName },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'skill.usage-stats error');
      return { success: false, output: `skill.usage-stats error: ${msg}` };
    }
  },
};
