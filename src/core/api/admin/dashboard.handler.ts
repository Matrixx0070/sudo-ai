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
 */

import os from 'node:os';
import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:dashboard');

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

  sendJson(res, 200, {
    cpu: Math.round(cpuUsage),
    memory: Math.round((usedMem / totalMem) * 100),
    memoryUsedMB: Math.round(usedMem / 1024 / 1024),
    memoryTotalMB: Math.round(totalMem / 1024 / 1024),
    disk: 0, // Placeholder — requires fs.statfs (Node 19+) or statvfs binding
    uptime: Math.round(os.uptime()),
    platform: os.platform(),
    nodeVersion: process.version,
    activeSessions: 0,
    tokensToday: 0,
    costToday: 0,
    agentActivity: { total: 8, active: 0 },
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
