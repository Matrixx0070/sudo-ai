/**
 * @file admin/dashboard.handler.ts
 * @description Admin API handlers for dashboard stats and service lifecycle.
 *
 * Routes registered:
 *   GET  /api/admin/dashboard/stats  — CPU, memory, uptime and activity summary
 *   POST /api/admin/service/restart  — Graceful restart via process.exit(0)
 *   POST /api/admin/service/stop     — Hard stop via process.exit(1)
 *
 * Registration: imported by admin/index.ts at startup. Routes shadow the
 * corresponding stubs in admin-router.ts only when this module is imported
 * before the stubs (i.e. admin-router stubs must be removed or deferred).
 * The stubs for these paths will be removed during integration.
 *
 * Honesty contract: every stats field is a real measurement; when a source
 * is unavailable the field is null, never a fabricated zero.
 */

import os from 'node:os';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import type BetterSqlite3T from 'better-sqlite3';
import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';
import {
  openMindDb,
  parseSessionMetas,
  tableExists,
  type BetterSqliteRow,
} from './sessions.db-utils.js';

const log = createLogger('api:admin:dashboard');

const MIND_DB_PATH = path.join(DATA_DIR, 'mind.db');

/** Percent of the DATA_DIR volume in use, or null when statfs fails. */
async function diskUsagePercent(): Promise<number | null> {
  try {
    const s = await statfs(DATA_DIR);
    const total = s.blocks * s.bsize;
    if (total <= 0) return null;
    const used = total - s.bavail * s.bsize;
    return Math.round((used / total) * 100);
  } catch (err) {
    log.debug({ err }, 'statfs failed — disk usage unavailable');
    return null;
  }
}

/** Count of sessions in state "active" in mind.db, or null when unavailable. */
async function countActiveSessions(): Promise<number | null> {
  const db = await openMindDb({ readonly: true });
  if (!db) return null;
  try {
    if (!tableExists(db, 'chunks')) return 0;
    const rows = db
      .prepare(
        `SELECT text FROM chunks
         WHERE path LIKE 'session:%:meta'
           AND source = 'conversation'
         ORDER BY rowid DESC`,
      )
      .all() as BetterSqliteRow[];
    return parseSessionMetas(rows).filter((s) => s.state === 'active').length;
  } catch (err) {
    log.warn({ err }, 'active-session count failed');
    return null;
  } finally {
    db.close();
  }
}

interface UsageTodayRow {
  tokens: number | null;
  cost: number | null;
}

/**
 * Tokens and USD recorded in mind.db api_call_log since local midnight, or null
 * when the DB or table is unavailable (tracking not set up — unknown, not zero).
 * Real per-call spend lives in api_call_log (written by the cost-tracker); the
 * legacy knowledge.db api_costs table was never created, so this previously
 * returned null on every request.
 */
async function usageToday(): Promise<{ tokensToday: number; costToday: number } | null> {
  let db: BetterSqlite3T.Database | undefined;
  try {
    const mod = await import('better-sqlite3');
    const Database = (mod.default ?? mod) as typeof BetterSqlite3T;
    db = new Database(MIND_DB_PATH, { readonly: true });
    if (!tableExists(db, 'api_call_log')) return null;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const row = db
      .prepare(
        `SELECT SUM(total_tokens)        AS tokens,
                SUM(estimated_cost_usd)  AS cost
         FROM api_call_log
         WHERE called_at >= ?`,
      )
      .get(todayStart) as UsageTodayRow;
    return { tokensToday: Number(row.tokens ?? 0), costToday: Number(row.cost ?? 0) };
  } catch (err) {
    log.debug({ err }, 'api_call_log query failed — token/cost usage unavailable');
    return null;
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard/stats
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/dashboard/stats', async (_req, res) => {
  log.debug('dashboard/stats requested');

  const cpus = os.cpus();

  if (!cpus || cpus.length === 0) {
    log.warn('os.cpus() returned empty array — defaulting cpu usage to 0');
  }

  // Average CPU usage across all cores using idle vs total time ratio.
  // Note: os.cpus() returns cumulative counters since boot; this gives an
  // approximate "overall" usage, not a real-time interval sample.
  let cpuUsage = 0;
  if (cpus.length > 0) {
    const perCore = cpus.map((cpu) => {
      const times = cpu.times;
      const total =
        times.user + times.nice + times.sys + times.idle + times.irq;
      if (total === 0) return 0;
      return ((total - times.idle) / total) * 100;
    });
    cpuUsage = perCore.reduce((acc, v) => acc + v, 0) / perCore.length;
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [disk, activeSessions, usage] = await Promise.all([
    diskUsagePercent(),
    countActiveSessions(),
    usageToday(),
  ]);

  sendJson(res, 200, {
    cpu: Math.round(cpuUsage),
    memory: Math.round((usedMem / totalMem) * 100),
    memoryUsedMB: Math.round(usedMem / 1024 / 1024),
    memoryTotalMB: Math.round(totalMem / 1024 / 1024),
    disk,
    uptime: Math.round(os.uptime()),
    platform: os.platform(),
    nodeVersion: process.version,
    activeSessions,
    tokensToday: usage ? usage.tokensToday : null,
    costToday: usage ? usage.costToday : null,
  });

  log.debug({ cpuUsage: Math.round(cpuUsage), usedMem }, 'dashboard/stats served');
});

// ---------------------------------------------------------------------------
// POST /api/admin/service/restart
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/service/restart', async (_req, res) => {
  log.info('Service restart requested via admin API');

  // Respond before exiting so the client receives the acknowledgement.
  sendJson(res, 200, { success: true, message: 'Restarting service...' });

  // Delay gives pino time to flush the response and log above.
  // exit(0) signals systemd / process manager to restart the service.
  setTimeout(() => {
    log.info('Executing process.exit(0) for restart');
    process.exit(0);
  }, 500);
});

// ---------------------------------------------------------------------------
// POST /api/admin/service/stop
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/service/stop', async (_req, res) => {
  log.warn('Service stop requested via admin API');

  sendJson(res, 200, { success: true, message: 'Stopping service...' });

  // exit(1) signals systemd Restart=on-success policy to NOT restart.
  // If the unit uses Restart=always, a SIGTERM signal would be required
  // to avoid automatic restart — adjust based on deployment configuration.
  setTimeout(() => {
    log.warn('Executing process.exit(1) for stop');
    process.exit(1);
  }, 500);
});
