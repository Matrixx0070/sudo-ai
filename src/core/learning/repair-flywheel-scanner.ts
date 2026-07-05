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
import { runLessonLifecycle, isApplyEnabled } from './lesson-apply.js';
import { verifyWorkflowOrder, decideWorkflowAdoption, WORKFLOW_REPAIRS, workflowScanBounds, type ToolEvent } from './workflow-order.js';

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
      // SHADOW workflow-ORDER verification (deterministic, free — no LLM). For each
      // registered ordering repair, reconstruct the sessions that hit its failure and
      // measure how many are ATTRIBUTABLE to the missing-predecessor pattern the lesson
      // fixes. Log-only — decides adopt/reject/insufficient, never applies.
      const bounds = workflowScanBounds();
      const sinceExpr = `datetime('now','-${bounds.lookbackDays} days')`;
      for (const wf of WORKFLOW_REPAIRS) {
        try {
          // Most-recent failing sessions within the age window, capped.
          const sessRows = db
            .prepare(`SELECT session_id FROM traces WHERE tool_name=? AND success=0 AND error_message LIKE ? AND session_id IS NOT NULL AND created_at >= ${sinceExpr} GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT ?`)
            .all(wf.tool, `%${wf.errorPattern}%`, bounds.maxSessions) as Array<{ session_id: string }>;
          if (sessRows.length === 0) continue;
          const ids = sessRows.map((r) => r.session_id);
          const placeholders = ids.map(() => '?').join(',');
          // Events for those sessions, within the window, hard-capped as a backstop.
          const eventRows = db
            .prepare(`SELECT session_id, tool_name, success, COALESCE(error_message,'') AS em, created_at, args_raw FROM traces WHERE tool_name IS NOT NULL AND session_id IN (${placeholders}) AND created_at >= ${sinceExpr} ORDER BY created_at LIMIT ?`)
            .all(...ids, bounds.maxEvents + 1) as Array<{ session_id: string; tool_name: string; success: number; em: string; created_at: string; args_raw: string | null }>;
          if (eventRows.length > bounds.maxEvents) {
            log.warn({ lessonId: wf.lessonId, cap: bounds.maxEvents, sessions: ids.length }, 'RepairFlywheel workflow-order: event cap hit — analysis truncated (raise SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS or narrow the window)');
            eventRows.length = bounds.maxEvents;
          }
          const events: ToolEvent[] = eventRows.map((r) => ({
            sessionId: r.session_id,
            tool: r.tool_name,
            success: r.success === 1,
            errorMessage: r.em,
            createdAtMs: Date.parse(`${r.created_at.replace(' ', 'T')}Z`),
            argsRaw: r.args_raw,
          }));
          const result = verifyWorkflowOrder(events, wf);
          log.info(
            { lessonId: wf.lessonId, ...result, decision: decideWorkflowAdoption(result), sessionCapHit: ids.length >= bounds.maxSessions },
            'RepairFlywheel SHADOW workflow-order verify (log-only, not applied)',
          );
        } catch (e) {
          log.warn({ lessonId: wf.lessonId, err: String(e) }, 'RepairFlywheel workflow-order verify failed (non-fatal)');
        }
      }

      // Canary lifecycle for ADOPTED lessons — advances candidate→canary→promoted/
      // reverted from REAL measured failure rates. Gated by SUDO_FLYWHEEL_APPLY
      // (default OFF → no-op). Measures a tool's failure rate over the canary window
      // from the same open DB. This is the ONLY step that mutates live behavior, and
      // it only ever promotes on a verified improvement (else auto-reverts).
      if (isApplyEnabled()) {
        const localDb = db;
        // Per-CLUSTER rate: numerator = failures whose error_message matches the
        // lesson's errorPattern; denominator = the tool's TOTAL calls (also the
        // sample-guard size). Placeholders bind in SQL-text order: LIKE (SELECT),
        // then tool (WHERE), then since.
        const measureClusterRate = (tool: string, errorPattern?: string, sinceISO?: string): { rate: number; calls: number } => {
          const failExpr = errorPattern ? 'success=0 AND error_message LIKE ?' : 'success=0';
          let sql = `SELECT COUNT(*) AS calls, SUM(CASE WHEN ${failExpr} THEN 1 ELSE 0 END) AS fails FROM traces WHERE tool_name=?`;
          const params: unknown[] = [];
          if (errorPattern) params.push(`%${errorPattern}%`);
          params.push(tool);
          if (sinceISO) { sql += ' AND created_at >= ?'; params.push(sinceISO.slice(0, 19).replace('T', ' ')); }
          const row = localDb.prepare(sql).get(...params) as { calls: number | null; fails: number | null } | undefined;
          const calls = row?.calls ?? 0;
          return { rate: calls > 0 ? (row?.fails ?? 0) / calls : 0, calls };
        };
        const now = new Date();
        const actions = runLessonLifecycle({ measureClusterRate, nowMs: now.getTime(), nowISO: now.toISOString() });
        if (actions.length > 0) log.warn({ actions }, 'RepairFlywheel APPLY: canary lifecycle advanced (live behavior changed)');
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
