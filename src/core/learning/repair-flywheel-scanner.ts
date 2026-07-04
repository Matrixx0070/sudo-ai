/**
 * @file learning/repair-flywheel-scanner.ts
 * @description Periodic, REPORT-ONLY driver for the repair flywheel (Phase A).
 *
 * On an interval it mines the trace store's real tool failures for addressable
 * (learnable) clusters and flags "system-bug" failure signatures — surfacing
 * actionable insight in the logs. It does NOT change agent behavior or apply any
 * lesson: applying lessons safely requires the verify-half (an A/B against the
 * eval set), which needs richer trace capture first. This is the observe-only
 * half wired to run continuously, so the addressable-failure signal (and any
 * harness bugs it exposes — like the read-file guard depth bug) show up over time.
 *
 * Fail-open: any error is logged, never thrown. The timer is unref'd so it never
 * holds the process open, and it opens the DB read-only.
 */
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import { mineFailureClusters, measureCoverage, type FailureRow } from './repair-flywheel.js';
import { runShadowVerification, makeReadFilePathRepair, type DeterministicRepair } from './repair-flywheel-verify.js';

const log = createLogger('learning:repair-flywheel');

export interface FlywheelScanReport {
  totalFailures: number;
  /** % of ALL failures addressable by a learnable repair lesson. */
  learnableCoveragePct: number;
  /** Count of failures whose signature is a harness bug, not agent error. */
  systemBugsFlagged: number;
  topClusters: Array<{ tool: string; signature: string; count: number }>;
  byLesson: Record<string, number>;
}

/** Pure: build the scan report from a set of failure rows (testable). */
export function buildFlywheelReport(rows: FailureRow[]): FlywheelScanReport {
  const clusters = mineFailureClusters(rows, 3);
  const cov = measureCoverage(rows);
  return {
    totalFailures: cov.total,
    learnableCoveragePct: cov.coveragePct,
    systemBugsFlagged: cov.systemBugs,
    topClusters: clusters.slice(0, 5).map((c) => ({ tool: c.tool, signature: c.signature, count: c.count })),
    byLesson: cov.byLesson,
  };
}

export class RepairFlywheelScanner {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly intervalMs: number = 6 * 60 * 60 * 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    // First scan shortly after boot (off the boot critical path), then periodic.
    const kick = setTimeout(() => this.scan(), 60_000);
    if (kick.unref) kick.unref();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs, db: this.dbPath }, 'RepairFlywheelScanner started (report-only)');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One scan. Synchronous (better-sqlite3), read-only, fail-open. */
  scan(): FlywheelScanReport | null {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare("SELECT tool_name, COALESCE(error_message,'') AS error_message, args_raw FROM traces WHERE success=0 AND tool_name IS NOT NULL")
        .all() as Array<FailureRow & { args_raw?: string | null }>;
      const report = buildFlywheelReport(rows);
      log.info({ ...report }, 'RepairFlywheel scan: addressable-failure report');
      if (report.systemBugsFlagged > 0) {
        log.warn(
          { systemBugsFlagged: report.systemBugsFlagged, byLesson: report.byLesson },
          'RepairFlywheel: system-bug failure signatures detected — a HARNESS bug, not agent error (investigate)',
        );
      }

      // SHADOW verify → adopt decision (log-only; NEVER applies to the live agent).
      // Replays captured failing inputs through registered deterministic repairs and
      // reports adopt/reject/insufficient. Inert until the args-capture corpus fills.
      const repairs: DeterministicRepair[] = [makeReadFilePathRepair(PROJECT_ROOT)];
      const decisions = runShadowVerification(rows, repairs);
      const withData = decisions.filter((d) => d.decision !== 'insufficient-data');
      if (withData.length > 0) {
        log.info({ decisions: withData }, 'RepairFlywheel SHADOW verify → adopt decision (log-only, not applied)');
      } else {
        log.info(
          { verifiableInputs: rows.filter((r) => r.args_raw).length },
          'RepairFlywheel SHADOW verify: no deterministic repair had enough captured inputs yet (corpus building)',
        );
      }
      return report;
    } catch (err) {
      log.warn({ err: String(err) }, 'RepairFlywheel scan failed (non-fatal)');
      return null;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
}
