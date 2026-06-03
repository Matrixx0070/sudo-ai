/**
 * dashboard-server.ts
 *
 * SUDO-AI Dashboard Server — real-time observability UI.
 *
 * Features:
 *   - System stats (uptime, requests, sessions, memory, CPU)
 *   - Health checks (brain, gateway, memory, alignment)
 *   - Prometheus-style metrics
 *   - Alignment score + signal breakdown
 *   - Recent activity feed
 *   - Kill-switch: SUDO_DASHBOARD_DISABLE=1
 */

import { createServer, type Server } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { DashboardConfig, DashboardStats, DashboardHealth, AlignmentData, ActivityEvent } from './dashboard-types.js';
import { registerRoutes } from './dashboard-routes.js';

const log = createLogger('dashboard');
const DASHBOARD_DISABLED = process.env['SUDO_DASHBOARD_DISABLE'] === '1';

const activityBuffer: ActivityEvent[] = [];
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

const metrics = {
  dashboardRequests: 0,
  dashboardErrors: 0,
  healthChecksOk: 0,
  healthChecksFail: 0,
};

/** DashboardServer class — manages HTTP server and aggregates observability data. */
export class DashboardServer {
  private config: DashboardConfig;
  private server: Server | null = null;
  private startTime: number = Date.now();
  private totalRequests = 0;
  private activeSessions = 0;

  constructor(config: DashboardConfig) {
    this.config = config;
    if (DASHBOARD_DISABLED) log.warn('Dashboard server disabled via SUDO_DASHBOARD_DISABLE=1');
  }

  /** Start the HTTP server. */
  start(): void {
    if (DASHBOARD_DISABLED) {
      log.info('Dashboard server start skipped (disabled)');
      return;
    }

    this.server = createServer((req, res) => {
      metrics.dashboardRequests++;
      registerRoutes(req, res, this, this.config);
    });

    this.server.on('error', (err) => {
      metrics.dashboardErrors++;
      log.error({ err: err.message, port: this.config.port }, 'Dashboard server error');
    });

    this.server.listen(this.config.port, '127.0.0.1', () => {
      log.info({ port: this.config.port }, 'Dashboard server started');
    });
  }

  /** Stop the HTTP server gracefully. */
  stop(): void {
    if (this.server) {
      this.server.close(() => log.info('Dashboard server stopped'));
      this.server = null;
    }
  }

  /** Aggregate system statistics. */
  getStats(): DashboardStats {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const memoryUsage = process.memoryUsage();
    const currentCpuUsage = process.cpuUsage();
    const currentTime = Date.now();
    const elapsedMs = currentTime - lastCpuTime;
    const totalCpuDiff = (currentCpuUsage.user - lastCpuUsage.user) + (currentCpuUsage.system - lastCpuUsage.system);
    const cpuUsage = elapsedMs > 0 ? Math.min(100, (totalCpuDiff / 1000 / elapsedMs) * 100) : 0;

    lastCpuUsage = currentCpuUsage;
    lastCpuTime = currentTime;

    return { uptime, totalRequests: this.totalRequests, activeSessions: this.activeSessions, memoryUsage, cpuUsage: Math.round(cpuUsage * 10) / 10 };
  }

  /** Check subsystem health. */
  getHealth(): DashboardHealth {
    const checks: DashboardHealth['checks'] = [];
    const pushCheck = (name: string, ok: boolean, msgOk: string, msgFail: string) => {
      const status = ok ? 'ok' : 'warn';
      checks.push({ name, status, message: ok ? msgOk : msgFail });
      if (ok) metrics.healthChecksOk++; else metrics.healthChecksFail++;
    };

    try { pushCheck('brain', typeof (globalThis as any).__sudoBrain !== 'undefined', 'Brain module loaded', 'Brain module not detected'); }
    catch { checks.push({ name: 'brain', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try { pushCheck('gateway', typeof (globalThis as any).__sudoGateway !== 'undefined', 'Gateway module loaded', 'Gateway module not detected'); }
    catch { checks.push({ name: 'gateway', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try {
      const mem = process.memoryUsage();
      const heapUsedPercent = (mem.heapUsed / mem.heapTotal) * 100;
      const status = heapUsedPercent > 90 ? 'error' : heapUsedPercent > 75 ? 'warn' : 'ok';
      checks.push({ name: 'memory', status, latency: Math.round(heapUsedPercent * 10) / 10, message: `Heap: ${Math.round(heapUsedPercent)}% used` });
      if (status === 'ok') metrics.healthChecksOk++; else metrics.healthChecksFail++;
    }
    catch { checks.push({ name: 'memory', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try { pushCheck('alignment', typeof (globalThis as any).__sudoAlignment !== 'undefined', 'Alignment system active', 'Alignment system not detected'); }
    catch { checks.push({ name: 'alignment', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    const hasError = checks.some(c => c.status === 'error');
    const hasWarn = checks.some(c => c.status === 'warn');
    return { status: hasError ? 'down' : hasWarn ? 'degraded' : 'healthy', checks };
  }

  /** Expose Prometheus-style metrics. */
  getMetrics(): Record<string, number> {
    const stats = this.getStats();
    return {
      sudo_dashboard_uptime_seconds: stats.uptime,
      sudo_dashboard_requests_total: metrics.dashboardRequests,
      sudo_dashboard_errors_total: metrics.dashboardErrors,
      sudo_system_cpu_percent: stats.cpuUsage,
      sudo_system_memory_rss_bytes: stats.memoryUsage.rss,
      sudo_system_heap_used_bytes: stats.memoryUsage.heapUsed,
      sudo_system_heap_total_bytes: stats.memoryUsage.heapTotal,
      sudo_system_active_sessions: stats.activeSessions,
      sudo_system_total_requests: stats.totalRequests,
      sudo_health_checks_ok: metrics.healthChecksOk,
      sudo_health_checks_fail: metrics.healthChecksFail,
    };
  }

  /** Get alignment score and signal breakdown. */
  getAlignment(): AlignmentData {
    const alignment = (globalThis as any).__sudoAlignment;
    if (alignment && typeof alignment.getDigest === 'function') {
      try {
        const digest = alignment.getDigest();
        return { score: digest?.overallScore ?? 0, signals: digest?.signals ?? {} };
      } catch { /* Fall through to default */ }
    }
    return { score: 0, signals: { veto: 0, discordance: 0, sleep: 0, epistemic: 0, commitment: 0, trust: 0, calibration: 0, brier: 0 } };
  }

  /** Get recent activity events. */
  getRecentActivity(limit: number): ActivityEvent[] {
    const clamped = Math.max(1, Math.min(100, limit));
    return [...activityBuffer].reverse().slice(0, clamped);
  }

  /** Record an activity event. */
  recordActivity(type: string, summary: string): void {
    activityBuffer.push({ timestamp: new Date().toISOString(), type, summary });
    if (activityBuffer.length > 100) activityBuffer.shift();
  }

  /** Update request/session counters. */
  setCounters(totalRequests: number, activeSessions: number): void {
    this.totalRequests = totalRequests;
    this.activeSessions = activeSessions;
  }
}

/** Singleton instance for external access. */
let dashboardInstance: DashboardServer | null = null;

/** Create or get the dashboard singleton. */
export function getDashboard(): DashboardServer | null {
  if (DASHBOARD_DISABLED) return null;
  return dashboardInstance;
}

/** Initialize the dashboard singleton. */
export function initDashboard(config: DashboardConfig): DashboardServer {
  if (DASHBOARD_DISABLED) {
    log.warn('Dashboard initialization skipped (disabled)');
    dashboardInstance = new DashboardServer(config);
    return dashboardInstance;
  }
  dashboardInstance = new DashboardServer(config);
  dashboardInstance.start();
  return dashboardInstance;
}

/** Shutdown the dashboard singleton. */
export function shutdownDashboard(): void {
  if (dashboardInstance) {
    dashboardInstance.stop();
    dashboardInstance = null;
  }
}
