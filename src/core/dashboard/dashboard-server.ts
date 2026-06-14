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
import {
  DashboardConfig,
  DashboardStats,
  DashboardHealth,
  AlignmentData,
  ActivityEvent,
  LiveAgentsData,
  AgentSwarmSource,
  BrainSource,
  UpdaterSource,
  AuditSource,
  UpdateCheckResult,
  UpdateApplyResult,
} from './dashboard-types.js';
import { registerRoutes } from './dashboard-routes.js';

const log = createLogger('dashboard');
const DASHBOARD_DISABLED = process.env['SUDO_DASHBOARD_DISABLE'] === '1';

/** Delay between sending the 202 response and `process.exit(0)` so the HTTP reply flushes. */
const RESTART_FLUSH_DELAY_MS = 250;

const activityBuffer: ActivityEvent[] = [];

// Optional runtime registration points: subsystems attach themselves via
// registerDashboardGlobals() (called from cli.ts at boot) so the dashboard
// can detect them. Unregistered subsystems honestly report "not detected"
// and getAlignment returns its zero default.
/** Provider of alignment digest data (score + signal breakdown). */
export interface AlignmentDigestSource {
  getDigest?: () => { overallScore?: number; signals?: Record<string, number> } | undefined;
}
interface SudoRuntimeGlobals {
  __sudoBrain?: BrainSource | unknown;
  __sudoGateway?: unknown;
  __sudoAlignment?: AlignmentDigestSource;
  __sudoAgentSwarm?: AgentSwarmSource;
  __sudoUpdater?: UpdaterSource;
  __sudoAudit?: AuditSource;
}
const runtimeGlobals = globalThis as SudoRuntimeGlobals;

/** Register live subsystem references for health checks, alignment data, and admin-power surfaces. */
export function registerDashboardGlobals(parts: {
  brain?: BrainSource | unknown;
  gateway?: unknown;
  alignment?: AlignmentDigestSource;
  agentSwarm?: AgentSwarmSource;
  updater?: UpdaterSource;
  audit?: AuditSource;
}): void {
  if (parts.brain !== undefined) runtimeGlobals.__sudoBrain = parts.brain;
  if (parts.gateway !== undefined) runtimeGlobals.__sudoGateway = parts.gateway;
  if (parts.alignment !== undefined) runtimeGlobals.__sudoAlignment = parts.alignment;
  if (parts.agentSwarm !== undefined) runtimeGlobals.__sudoAgentSwarm = parts.agentSwarm;
  if (parts.updater !== undefined) runtimeGlobals.__sudoUpdater = parts.updater;
  if (parts.audit !== undefined) runtimeGlobals.__sudoAudit = parts.audit;
}

/**
 * Structural Brain narrowing for `getCurrentModel()` / `switchModel()` —
 * `__sudoBrain` is `unknown` at the registry boundary; the callers below verify
 * the two methods exist before invoking. Returns `undefined` when the brain is
 * not registered or doesn't expose the model API.
 */
function brainAsSource(): BrainSource | undefined {
  const b = runtimeGlobals.__sudoBrain as BrainSource | undefined;
  if (!b) return undefined;
  if (typeof b.getModel !== 'function' || typeof b.setModel !== 'function') return undefined;
  return b;
}
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

    try { pushCheck('brain', typeof runtimeGlobals.__sudoBrain !== 'undefined', 'Brain module loaded', 'Brain module not detected'); }
    catch { checks.push({ name: 'brain', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try { pushCheck('gateway', typeof runtimeGlobals.__sudoGateway !== 'undefined', 'Gateway module loaded', 'Gateway module not detected'); }
    catch { checks.push({ name: 'gateway', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try {
      const mem = process.memoryUsage();
      const heapUsedPercent = (mem.heapUsed / mem.heapTotal) * 100;
      const status = heapUsedPercent > 90 ? 'error' : heapUsedPercent > 75 ? 'warn' : 'ok';
      checks.push({ name: 'memory', status, latency: Math.round(heapUsedPercent * 10) / 10, message: `Heap: ${Math.round(heapUsedPercent)}% used` });
      if (status === 'ok') metrics.healthChecksOk++; else metrics.healthChecksFail++;
    }
    catch { checks.push({ name: 'memory', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    try { pushCheck('alignment', typeof runtimeGlobals.__sudoAlignment !== 'undefined', 'Alignment system active', 'Alignment system not detected'); }
    catch { checks.push({ name: 'alignment', status: 'error', message: 'Health check failed' }); metrics.healthChecksFail++; }

    const hasError = checks.some(c => c.status === 'error');
    const hasWarn = checks.some(c => c.status === 'warn');
    return { status: hasError ? 'down' : hasWarn ? 'degraded' : 'healthy', checks };
  }

  /** Expose Prometheus-style metrics. */
  getMetrics(): Record<string, number> {
    const stats = this.getStats();
    const fleet = this.getLiveAgents();
    const fleetIdle = fleet.spawned.reduce((n, a) => n + (a.idle ? 1 : 0), 0);
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
      // FleetView agent metrics (gap #25 slice 1). When no swarm is
      // registered these are all zero — `getLiveAgents()` returns an
      // empty default for the same reason `getAlignment()` does.
      sudo_agents_spawned: fleet.spawned.length,
      sudo_agents_idle: fleetIdle,
      sudo_agents_slots_used: fleet.slotsUsed,
      sudo_agents_slots_max: fleet.slotsMax,
      sudo_agents_queue_waiting: fleet.queueWaiting,
    };
  }

  /** Get alignment score and signal breakdown. */
  getAlignment(): AlignmentData {
    const alignment = runtimeGlobals.__sudoAlignment;
    if (alignment && typeof alignment.getDigest === 'function') {
      try {
        const digest = alignment.getDigest();
        return { score: digest?.overallScore ?? 0, signals: digest?.signals ?? {} };
      } catch { /* Fall through to default */ }
    }
    return { score: 0, signals: { veto: 0, discordance: 0, sleep: 0, epistemic: 0, commitment: 0, trust: 0, calibration: 0, brier: 0 } };
  }

  /**
   * Get the live FleetView snapshot — what `/api/agents/live` serves
   * (gap #25 slice 1). Reads from `__sudoAgentSwarm` registered via
   * `registerDashboardGlobals`. When no source is registered or the source
   * throws, returns a zero default so the endpoint never 500s.
   */
  getLiveAgents(): LiveAgentsData {
    const empty: LiveAgentsData = { spawned: [], slotsUsed: 0, slotsMax: 0, queueWaiting: 0 };
    const src = runtimeGlobals.__sudoAgentSwarm;
    if (src && typeof src.getSnapshot === 'function') {
      try {
        const snap = src.getSnapshot();
        if (snap) return snap;
      } catch {
        // Fall through to the empty default — never 500 the endpoint.
      }
    }
    return empty;
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

  // -------------------------------------------------------------------------
  // Admin-power surfaces (#28b slice 1 — Hermes parity)
  // -------------------------------------------------------------------------
  //
  // Three mutation endpoints, each Bearer-gated AND opt-in behind
  // SUDO_ADMIN_POWERS=1 (so a stock dashboard exposes nothing destructive).
  // Each call audit-logs through __sudoAudit when registered; absence of the
  // audit chain is non-fatal so the dashboard never blocks operator control
  // on observability.
  // -------------------------------------------------------------------------

  /** True iff opt-in flag SUDO_ADMIN_POWERS=1 is set. Re-read per call so tests can toggle. */
  adminPowersEnabled(): boolean {
    return process.env['SUDO_ADMIN_POWERS'] === '1';
  }

  /**
   * The active LLM model id ("provider/model-id"). Returns `undefined` when
   * the Brain is not registered or lacks `getModel()`.
   */
  getCurrentModel(): string | undefined {
    const b = brainAsSource();
    try { return b?.getModel(); } catch { return undefined; }
  }

  /**
   * Switch the primary model at runtime.
   * @returns the new active model on success.
   * @throws when target is not in the configured failover chain (Brain throws
   *         LLMError; we re-throw so the route handler can map to 400).
   */
  switchModel(target: string, actor: string): string {
    const b = brainAsSource();
    if (!b) {
      this.audit(actor, 'admin.model.set', target, 'error', { reason: 'brain_not_registered' });
      throw new Error('brain_not_registered');
    }
    try {
      b.setModel(target);
      const now = b.getModel();
      this.audit(actor, 'admin.model.set', target, 'success', { newModel: now });
      return now;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(actor, 'admin.model.set', target, 'denied', { reason: message });
      throw err;
    }
  }

  /**
   * Schedule a self-exit so PM2 (or whatever supervises this process) respawns.
   * Returns the planned exit delay so the caller can hold the response window
   * open just long enough for the HTTP reply to flush.
   */
  requestRestart(actor: string, reason: string): { acceptedAt: string; exitInMs: number } {
    const acceptedAt = new Date().toISOString();
    this.audit(actor, 'admin.restart', 'process', 'success', { reason, exitInMs: RESTART_FLUSH_DELAY_MS });
    log.warn({ actor, reason, exitInMs: RESTART_FLUSH_DELAY_MS }, 'Restart requested via dashboard — process.exit(0) scheduled');
    // Test-only short-circuit: SUDO_DASHBOARD_RESTART_NOEXIT=1 keeps the audit
    // + log + return shape live but skips the actual process exit so suites
    // that exercise this endpoint don't kill the vitest runner. Safe in prod:
    // env vars cannot be changed mid-process, so a remote attacker reaching
    // POST /api/admin/restart cannot also flip this flag — it had to be set
    // before the supervisor spawned the process. The endpoint still requires
    // Bearer + SUDO_ADMIN_POWERS=1 gates regardless.
    if (process.env['SUDO_DASHBOARD_RESTART_NOEXIT'] !== '1') {
      setTimeout(() => {
        log.warn('Exiting now for supervisor restart');
        // eslint-disable-next-line n/no-process-exit
        process.exit(0);
      }, RESTART_FLUSH_DELAY_MS).unref();
    }
    return { acceptedAt, exitInMs: RESTART_FLUSH_DELAY_MS };
  }

  /**
   * Preview an available update via `updater.checkNow()` without mutating
   * anything. Returns `{available: false, reason: 'updater_not_registered'}`
   * when no updater is wired so the endpoint stays honest.
   */
  async previewUpdate(channel: string | undefined, actor: string): Promise<UpdateCheckResult & { previewed: true }> {
    const u = runtimeGlobals.__sudoUpdater;
    if (!u) {
      this.audit(actor, 'admin.update.preview', channel ?? 'default', 'error', { reason: 'updater_not_registered' });
      return { previewed: true, available: false, reason: 'updater_not_registered' };
    }
    try {
      const result = await u.checkNow(channel);
      this.audit(actor, 'admin.update.preview', channel ?? 'default', 'success', { available: result.available, newVersion: result.newVersion });
      return { previewed: true, ...result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(actor, 'admin.update.preview', channel ?? 'default', 'error', { reason: message });
      return { previewed: true, available: false, reason: message };
    }
  }

  /**
   * Trigger a real update (`git pull` + `pnpm install` + `pnpm build` + `pm2
   * reload`). Fire-and-forget — returns immediately because `pm2 reload` may
   * kill the response mid-flush.
   *
   * The promise from `applyUpdate()` is intentionally orphaned; errors are
   * logged + audited inside the .then/.catch chain rather than propagated.
   */
  triggerUpdate(channel: string | undefined, actor: string): { accepted: true; channel?: string; acceptedAt: string } | { accepted: false; reason: string } {
    const u = runtimeGlobals.__sudoUpdater;
    if (!u) {
      this.audit(actor, 'admin.update.apply.queued', channel ?? 'default', 'error', { reason: 'updater_not_registered' });
      return { accepted: false, reason: 'updater_not_registered' };
    }
    const acceptedAt = new Date().toISOString();
    // First chain entry: ONLY the acceptance, not the apply. The action name
    // ".queued" + the outcome 'success' refer to the queue-onto-background-job
    // succeeding — NOT to the update having been applied. The real apply
    // result lands in the second chain entry below (action .result) so any
    // future audit-chain reader scanning for failed updates must look at
    // .result, not .queued.
    this.audit(actor, 'admin.update.apply.queued', channel ?? 'default', 'success', { acceptedAt, note: 'queued; real result in admin.update.apply.result' });
    log.warn({ actor, channel }, 'Update triggered via dashboard — applyUpdate started in background');
    u.applyUpdate(channel)
      .then((result: UpdateApplyResult) => {
        log.warn({ result }, 'applyUpdate() settled');
        this.audit(actor, 'admin.update.apply.result', channel ?? 'default', result.success ? 'success' : 'failure', { ...result });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'applyUpdate() rejected');
        this.audit(actor, 'admin.update.apply.result', channel ?? 'default', 'error', { reason: message });
      });
    return { accepted: true, ...(channel !== undefined && { channel }), acceptedAt };
  }

  /**
   * Best-effort audit log shim. The dashboard never blocks operator control
   * on the audit chain being available; failures are logged + swallowed.
   */
  private audit(actor: string, action: string, resource: string, outcome: 'success' | 'failure' | 'denied' | 'error', metadata?: Record<string, unknown>): void {
    const a = runtimeGlobals.__sudoAudit;
    if (!a) return;
    try {
      a.record({ actor, action, resource, outcome, ...(metadata !== undefined && { metadata }) });
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Audit append failed (non-fatal)');
    }
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
