/**
 * @file watchdog.ts
 * @description Watchdog — monitors SUDO-AI's health and triggers auto-recovery.
 *
 * Runs periodic checks (default 60 s):
 *  1. Brain connectivity  — LLM provider env keys present?
 *  2. Database integrity  — all 3 DBs readable?
 *  3. Disk space          — >90% triggers cleanup
 *  4. Memory usage        — >80% triggers GC hint
 *  5. API key validity    — env keys non-empty per provider
 *  6. Telegram polling    — heartbeat-state.json freshness
 *  7. Log file size       — rotate if >50 MB
 *  8. Consciousness stream — thought count growing?
 *
 * Check implementations live in checks.ts.
 * No service restarts are performed — in-process recovery only.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import {
  checkBrain,
  checkDatabases,
  checkDiskSpace,
  checkMemory,
  checkApiKeys,
  checkTelegram,
  checkLogs,
  checkConsciousness,
} from './checks.js';
import { checkCacheDupRate } from '../../llm/cache/dup-watch.js';
import { checkCacheHitRate } from '../../llm/cache/hit-rate.js';
import { fixLogRotation, fixDiskSpace, fixMemory } from './fixes.js';
import { ErrorReporter, ErrorSeverity } from './error-reporter.js';
import { HealthAlertPolicy } from './alert-policy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
  lastCheck: string;
  autoFix?: string;
}

export type AlertSink = (
  severity: 'high' | 'critical',
  check: HealthCheck,
  kind: 'failure' | 'recovery',
) => void;

/** Liveness heartbeat file — mtime goes stale when the event loop is blocked. */
export const LIVENESS_FILE = path.join(DATA_DIR, 'watchdog-liveness.json');

/**
 * Feed one round of check results through the alert policy and invoke the
 * sink for every alert/recovery decision. Extracted for direct unit testing.
 */
export function dispatchAlerts(
  checks: HealthCheck[],
  policy: HealthAlertPolicy,
  sink: AlertSink,
  nowMs: number = Date.now(),
): void {
  for (const check of checks) {
    const decision = policy.onCheckResult(check.name, check.status, nowMs);
    if (decision.action === 'alert') {
      sink(decision.severity, check, 'failure');
    } else if (decision.action === 'recovered') {
      sink('high', check, 'recovery');
    }
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('health:watchdog');

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class Watchdog {
  private checks: HealthCheck[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastConsciousnessThoughts = 0;
  private consecutiveFailures: Map<string, number> = new Map();
  private errorReporter: ErrorReporter | null = null;
  private alertSink: AlertSink | null = null;
  private brainLivenessCheck: (() => Promise<HealthCheck>) | null = null;
  private alertPolicy = new HealthAlertPolicy({
    cooldownMs: parsePositiveInt(process.env['SUDO_HEALTH_ALERT_COOLDOWN_MS'], 2_700_000),
    // Unchanged still-broken states remind at most daily (2026-07-18 anti-spam fix).
    reminderMs: parsePositiveInt(process.env['SUDO_HEALTH_ALERT_REMINDER_MS'], 86_400_000),
    degradedConsecutiveThreshold: 3,
  });

  /**
   * Start the watchdog loop.
   * @param intervalMs Check interval in milliseconds (default 60 000).
   */
  start(intervalMs = 60_000): void {
    if (this.interval !== null) {
      log.warn('Watchdog already running — ignoring duplicate start()');
      return;
    }

    if (intervalMs < 5_000) {
      throw new RangeError(`Watchdog intervalMs must be >= 5000, got ${intervalMs}`);
    }

    log.info({ intervalMs }, 'Watchdog starting');

    // Run immediately on start, then on each interval tick.
    void this._runAllChecks();
    this.interval = setInterval(() => void this._runAllChecks(), intervalMs);
    // Allow the process to exit even with the interval active.
    this.interval.unref();
  }

  /** Stop the watchdog loop. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
      log.info('Watchdog stopped');
    }
  }

  /** Return a snapshot of the latest health check results. */
  getStatus(): HealthCheck[] {
    return [...this.checks];
  }

  /**
   * Returns true when every check is 'healthy' or 'degraded'.
   * Returns false if any check is 'critical'.
   */
  isHealthy(): boolean {
    if (this.checks.length === 0) return true; // not yet run
    return this.checks.every((c) => c.status !== 'critical');
  }

  /**
   * Set the ErrorReporter for capturing health check failures.
   * @param reporter ErrorReporter instance
   */
  setErrorReporter(reporter: ErrorReporter): void {
    this.errorReporter = reporter;
    log.info('ErrorReporter attached to Watchdog');
  }

  /**
   * Attach a sink that receives alert/recovery decisions (cooldown- and
   * threshold-filtered by HealthAlertPolicy). Used to push health alerts to
   * the operator channels via the proactive notifier.
   */
  /**
   * Attach a real brain-liveness check (a throttled probe that drives an
   * actual brain call). When set, it runs alongside the other checks and its
   * critical verdict flows through the alert policy → operator channels.
   */
  setBrainLivenessCheck(check: () => Promise<HealthCheck>): void {
    this.brainLivenessCheck = check;
    log.info('Brain-liveness check attached to Watchdog');
  }

  setAlertSink(sink: AlertSink): void {
    this.alertSink = sink;
    log.info('Alert sink attached to Watchdog');
  }

  // -------------------------------------------------------------------------
  // Internal — run all checks
  // -------------------------------------------------------------------------

  private async _runAllChecks(): Promise<void> {
    const runners: Array<{ name: string; run: () => Promise<HealthCheck> }> = [
      { name: 'brain', run: () => checkBrain() },
      { name: 'databases', run: () => checkDatabases() },
      { name: 'disk_space', run: () => checkDiskSpace(fixDiskSpace) },
      { name: 'memory', run: () => checkMemory(fixMemory) },
      { name: 'api_keys', run: () => checkApiKeys() },
      { name: 'telegram_polling', run: () => checkTelegram() },
      { name: 'log_file', run: () => checkLogs(fixLogRotation) },
      { name: 'consciousness_stream', run: () => this._runConsciousnessCheck() },
      { name: 'cache_dup_rate', run: () => checkCacheDupRate() },
      { name: 'cache_hit_rate', run: () => checkCacheHitRate() },
    ];
    // Real brain-liveness probe (actually drives a call) — only when a probe
    // was attached. checkBrain() above only sees key PRESENCE; this catches an
    // invalid key / dead-provider outage that presence checks miss.
    if (this.brainLivenessCheck) {
      runners.push({ name: 'brain_liveness', run: this.brainLivenessCheck });
    }

    const settled = await Promise.allSettled(runners.map((r) => r.run()));

    // Dead-man's heartbeat: refreshed every tick, so a blocked event loop
    // (hung-but-alive process) leaves a stale mtime that the host cron
    // keepalive can act on. Best-effort — never let it break the checks.
    try {
      writeFileSync(LIVENESS_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), 'utf-8');
    } catch { /* ignore */ }

    this.checks = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;

      const name = runners[i]?.name ?? `check_${i}`;

      log.error({ err: String(r.reason) }, `Health check threw: ${name}`);

      return {
        name,
        status: 'critical' as const,
        message: `Check threw unexpectedly: ${String(r.reason)}`,
        lastCheck: new Date().toISOString(),
      };
    });

    // Verification aid: force one named check to critical so the alert path
    // can be exercised end-to-end without breaking anything real.
    const forceFail = process.env['SUDO_HEALTH_FORCE_FAIL'];
    if (forceFail) {
      this.checks = this.checks.map((c) =>
        c.name === forceFail
          ? { ...c, status: 'critical' as const, message: `FORCED critical via SUDO_HEALTH_FORCE_FAIL (${c.message})` }
          : c,
      );
    }

    if (this.alertSink && process.env['SUDO_HEALTH_ALERT_DISABLE'] !== '1') {
      try {
        dispatchAlerts(this.checks, this.alertPolicy, this.alertSink);
      } catch (err) {
        log.error({ err: String(err) }, 'Alert sink threw');
      }
    }

    this._logSummary();
  }

  private async _runConsciousnessCheck(): Promise<HealthCheck> {
    const { check, count } = await checkConsciousness(this.lastConsciousnessThoughts);
    this.lastConsciousnessThoughts = count;
    return check;
  }

  private async _logSummary(): Promise<void> {
    const criticals = this.checks.filter((c) => c.status === 'critical');
    const degraded  = this.checks.filter((c) => c.status === 'degraded');

    if (criticals.length > 0) {
      log.warn(
        { criticals: criticals.map((c) => c.name) },
        `${criticals.length} critical health check(s) detected`,
      );

      // Report each critical failure
      for (const check of criticals) {
        await this._handleCheckFailure(check, 'critical');
      }
    } else if (degraded.length > 0) {
      log.info(
        { degraded: degraded.map((c) => c.name) },
        `${degraded.length} degraded check(s)`,
      );

      // Report degraded checks (only if consecutive failures >= 3)
      for (const check of degraded) {
        await this._handleCheckFailure(check, 'degraded');
      }
    } else {
      // All checks passed - reset consecutive counters
      for (const check of this.checks) {
        this.consecutiveFailures.set(check.name, 0);
      }
      log.debug('All health checks passed');
    }
  }

  private async _handleCheckFailure(check: HealthCheck, status: 'critical' | 'degraded'): Promise<void> {
    if (process.env['SUDO_HEALTH_ALERT_DISABLE'] === '1') {
      return;
    }

    // Increment consecutive failure count
    const currentCount = this.consecutiveFailures.get(check.name) ?? 0;
    const newCount = currentCount + 1;
    this.consecutiveFailures.set(check.name, newCount);

    // Determine severity: CRITICAL if status=critical or consecutive >= 3, else HIGH
    const severity: ErrorSeverity = (status === 'critical' || newCount >= 3) ? 'CRITICAL' : 'HIGH';

    // Capture via ErrorReporter
    if (this.errorReporter) {
      const error = new Error(`Health check ${status}: ${check.message}`);
      await this.errorReporter.capture(error, severity, {
        healthCheck: check.name,
        status,
        consecutiveFailures: newCount,
      });
    }
  }
}
