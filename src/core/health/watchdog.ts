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

import { createLogger } from '../shared/logger.js';
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
import { fixLogRotation, fixDiskSpace, fixMemory } from './fixes.js';

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

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('health:watchdog');

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export class Watchdog {
  private checks: HealthCheck[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastConsciousnessThoughts = 0;

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

  // -------------------------------------------------------------------------
  // Internal — run all checks
  // -------------------------------------------------------------------------

  private async _runAllChecks(): Promise<void> {
    const runners: Array<() => Promise<HealthCheck>> = [
      () => checkBrain(),
      () => checkDatabases(),
      () => checkDiskSpace(fixDiskSpace),
      () => checkMemory(fixMemory),
      () => checkApiKeys(),
      () => checkTelegram(),
      () => checkLogs(fixLogRotation),
      () => this._runConsciousnessCheck(),
    ];

    const settled = await Promise.allSettled(runners.map((fn) => fn()));

    this.checks = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;

      const name = [
        'brain', 'databases', 'disk_space', 'memory',
        'api_keys', 'telegram_polling', 'log_file', 'consciousness_stream',
      ][i] ?? `check_${i}`;

      log.error({ err: String(r.reason) }, `Health check threw: ${name}`);

      return {
        name,
        status: 'critical' as const,
        message: `Check threw unexpectedly: ${String(r.reason)}`,
        lastCheck: new Date().toISOString(),
      };
    });

    this._logSummary();
  }

  private async _runConsciousnessCheck(): Promise<HealthCheck> {
    const { check, count } = await checkConsciousness(this.lastConsciousnessThoughts);
    this.lastConsciousnessThoughts = count;
    return check;
  }

  private _logSummary(): void {
    const criticals = this.checks.filter((c) => c.status === 'critical');
    const degraded  = this.checks.filter((c) => c.status === 'degraded');

    if (criticals.length > 0) {
      log.warn(
        { criticals: criticals.map((c) => c.name) },
        `${criticals.length} critical health check(s) detected`,
      );
    } else if (degraded.length > 0) {
      log.info(
        { degraded: degraded.map((c) => c.name) },
        `${degraded.length} degraded check(s)`,
      );
    } else {
      log.debug('All health checks passed');
    }
  }
}
