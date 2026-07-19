/**
 * @file learning/repair-flywheel-scanner.ts
 * @description Periodic driver for the repair flywheel (Phase A + F86 apply).
 *
 * On an interval it mines the trace store's real tool failures for addressable
 * (learnable) clusters and flags "system-bug" failure signatures — surfacing
 * actionable insight in the logs. The SCAN half is report-only and never changes
 * agent behavior.
 *
 * F86 adds the APPLY half, gated by SUDO_FLYWHEEL_APPLY (default OFF → no-op, no
 * disk read, no LLM call): after each scan it advances adopted lessons through their
 * canary lifecycle and, for any lesson its own verification would PROMOTE, runs the
 * two-reader consensus gate (invariant 9) — an INDEPENDENT judge-route read that must
 * agree — under a daily cap + per-run budget (invariant 10), auditing every decision.
 * Disagreement / no independent judge / cap / budget → escalate, never execute.
 *
 * Fail-open: any error is logged, never thrown. Timers are unref'd so they never hold
 * the process open, and DBs are opened read-only.
 */
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import { mineFailureClusters, measureCoverage, type FailureRow } from './repair-flywheel.js';
import { runShadowVerification, makeReadFilePathRepair, type DeterministicRepair } from './repair-flywheel-verify.js';
import { runLessonApplyConsensus, isApplyEnabled, type LifecycleDeps } from './lesson-apply.js';
import { makeJudgeConsensusReader, type JudgeChatFn } from './lesson-consensus.js';
import { verifyWorkflowOrder, decideWorkflowAdoption, WORKFLOW_REPAIRS, workflowScanBounds, type ToolEvent } from './workflow-order.js';
import { verifyRetryPolicy, decideRetryPolicyAdoption, RETRY_POLICIES } from './retry-policy.js';
import { mineHarnessBugs, HARNESS_CRASH_LIKE_FRAGMENTS, type HarnessBugRow } from './harness-bug-scan.js';

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
    const kick = setTimeout(() => void this.tick(), 60_000);
    if (kick.unref) kick.unref();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs, db: this.dbPath }, 'RepairFlywheelScanner started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One periodic tick: report-only scan, then (if apply enabled) the consensus apply step. */
  async tick(): Promise<void> {
    this.scan();
    try {
      await this.applyConsensusStep();
    } catch (e) {
      log.warn({ err: String(e) }, 'RepairFlywheel consensus apply step failed (non-fatal)');
    }
  }

  /** One scan. Synchronous (better-sqlite3), read-only, fail-open. Report-only. */
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
      const localDbSeq = db;
      // Shared bounded loader: the recent failing sessions for (tool, errorPattern) and
      // all their events, as ToolEvents. Returns null when there are no failing sessions.
      const loadSessionEvents = (id: string, tool: string, errorPattern: string): { events: ToolEvent[]; sessionCapHit: boolean } | null => {
        const sessRows = localDbSeq
          .prepare(`SELECT session_id FROM traces WHERE tool_name=? AND success=0 AND error_message LIKE ? AND session_id IS NOT NULL AND created_at >= ${sinceExpr} GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT ?`)
          .all(tool, `%${errorPattern}%`, bounds.maxSessions) as Array<{ session_id: string }>;
        if (sessRows.length === 0) return null;
        const ids = sessRows.map((r) => r.session_id);
        const placeholders = ids.map(() => '?').join(',');
        const eventRows = localDbSeq
          .prepare(`SELECT session_id, tool_name, success, COALESCE(error_message,'') AS em, created_at, args_raw FROM traces WHERE tool_name IS NOT NULL AND session_id IN (${placeholders}) AND created_at >= ${sinceExpr} ORDER BY created_at LIMIT ?`)
          .all(...ids, bounds.maxEvents + 1) as Array<{ session_id: string; tool_name: string; success: number; em: string; created_at: string; args_raw: string | null }>;
        if (eventRows.length > bounds.maxEvents) {
          log.warn({ id, cap: bounds.maxEvents, sessions: ids.length }, 'RepairFlywheel sequence verify: event cap hit — analysis truncated (raise SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS or narrow the window)');
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
        return { events, sessionCapHit: ids.length >= bounds.maxSessions };
      };

      for (const wf of WORKFLOW_REPAIRS) {
        try {
          const loaded = loadSessionEvents(wf.lessonId, wf.tool, wf.errorPattern);
          if (!loaded) continue;
          const result = verifyWorkflowOrder(loaded.events, wf);
          log.info(
            { lessonId: wf.lessonId, ...result, decision: decideWorkflowAdoption(result), sessionCapHit: loaded.sessionCapHit },
            'RepairFlywheel SHADOW workflow-order verify (log-only, not applied)',
          );
        } catch (e) {
          log.warn({ lessonId: wf.lessonId, err: String(e) }, 'RepairFlywheel workflow-order verify failed (non-fatal)');
        }
      }

      // SHADOW retry-POLICY verification (deterministic, free). Looks FORWARD after each
      // failure for a recovery action + successful retry, measuring the policy's observed
      // efficacy. Log-only RECOMMENDATION — a retry-policy is a CODE change and is NEVER
      // auto-applied (unlike an advisory lesson); a high recoveryPct flags it for a
      // human-reviewed implementation (e.g. auto-re-snapshot in click.ts).
      for (const rp of RETRY_POLICIES) {
        try {
          const loaded = loadSessionEvents(rp.policyId, rp.tool, rp.errorPattern);
          if (!loaded) continue;
          const result = verifyRetryPolicy(loaded.events, rp);
          log.info(
            { policyId: rp.policyId, ...result, decision: decideRetryPolicyAdoption(result), sessionCapHit: loaded.sessionCapHit },
            'RepairFlywheel SHADOW retry-policy verify (recommendation — code change, never auto-applied)',
          );
        } catch (e) {
          log.warn({ policyId: rp.policyId, err: String(e) }, 'RepairFlywheel retry-policy verify failed (non-fatal)');
        }
      }

      // HARNESS-BUG scan — surface uncaught runtime crashes inside tools (TypeError,
      // ReferenceError, null property reads) as CODE bugs to fix, distinct from agent
      // errors. Cheap SQL pre-filter (LIKE) then precise classification. Log-only WARN;
      // never auto-applied. Systematizes the #607-class find (browser.navigate crash).
      try {
        const likeClause = HARNESS_CRASH_LIKE_FRAGMENTS.map(() => 'error_message LIKE ?').join(' OR ');
        const likeParams = HARNESS_CRASH_LIKE_FRAGMENTS.map((f) => `%${f}%`);
        const crashRows = db
          .prepare(`SELECT tool_name, COALESCE(error_message,'') AS error_message, created_at FROM traces WHERE success=0 AND tool_name IS NOT NULL AND created_at >= ${sinceExpr} AND (${likeClause}) LIMIT ?`)
          .all(...likeParams, bounds.maxEvents) as HarnessBugRow[];
        // A crash whose last occurrence predates the active window is likely ALREADY
        // FIXED (its traces just haven't aged out) — suppress it from the WARN so the
        // scan surfaces only STILL-RECURRING bugs. (The read-file __dirname crash, fixed
        // #223 weeks ago, was exactly this stale false alarm.) Tunable via env.
        const activeDays = Math.max(1, Number.parseInt(process.env['SUDO_FLYWHEEL_HARNESS_ACTIVE_DAYS'] ?? '7', 10) || 7);
        const cutoffMs = Date.now() - activeDays * 24 * 60 * 60 * 1000;
        const cutoffISO = new Date(cutoffMs).toISOString().slice(0, 19).replace('T', ' ');
        const all = mineHarnessBugs(crashRows, 1, cutoffISO);
        const active = all.filter((b) => b.active).slice(0, 10);
        const staleSuppressed = all.length - all.filter((b) => b.active).length;
        if (active.length > 0) {
          log.warn({ harnessBugCount: active.length, staleSuppressed, bugs: active }, 'RepairFlywheel HARNESS-BUG scan: STILL-RECURRING tool crashes — CODE bugs to fix (not agent error, never auto-applied)');
        } else if (all.length > 0) {
          log.info({ staleSuppressed }, 'RepairFlywheel HARNESS-BUG scan: only stale (likely-fixed) crashes remain — none active');
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'RepairFlywheel harness-bug scan failed (non-fatal)');
      }

      return report;
    } catch (err) {
      log.warn({ err: String(err) }, 'RepairFlywheel scan failed (non-fatal)');
      return null;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  /**
   * F86 APPLY STEP — consensus-gated canary lifecycle. Gated by SUDO_FLYWHEEL_APPLY
   * (default OFF → immediate no-op, no DB open, no LLM call). Opens its OWN read-only
   * DB (independent of scan's, so the async reader calls never touch a closed handle),
   * measures per-cluster failure rates, and runs the two-reader consensus driver. The
   * independent second reader is a judge-route LLM read (lazy `chatIR` import off the
   * boot path). Fail-open.
   */
  async applyConsensusStep(): Promise<void> {
    if (!isApplyEnabled()) return; // default OFF — byte-identical to today, no I/O.
    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const localDb = db;
      // Per-CLUSTER rate: numerator = failures whose error_message matches the lesson's
      // errorPattern; denominator = the tool's TOTAL calls (also the sample-guard size).
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
      const deps: LifecycleDeps = { measureClusterRate, nowMs: now.getTime(), nowISO: now.toISOString() };

      // Independent second reader: a judge-route LLM read (lazy import keeps transport
      // off the boot path). On any construction failure the reader stays absent → the
      // consensus gate HOLDS (escalates), never promotes.
      const { chatIR } = await import('../../llm/client.js');
      const chat: JudgeChatFn = async (route, system, user) => {
        const res = await chatIR({
          alias: route,
          caller: 'learning:flywheel-consensus',
          purpose: 'F86 two-reader lesson promotion',
          system,
          messages: [{ role: 'user', content: user }],
          maxTokens: 200,
          temperature: 0,
          priority: 'background',
        });
        return { text: res.text, tokensIn: res.usage.in, tokensOut: res.usage.out };
      };
      const reader = makeJudgeConsensusReader(chat);

      const actions = await runLessonApplyConsensus(deps, reader);
      if (actions.length > 0) {
        log.warn({ actions }, 'RepairFlywheel APPLY: consensus-gated canary lifecycle advanced (live behavior may have changed)');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'RepairFlywheel apply step failed (non-fatal)');
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
}
