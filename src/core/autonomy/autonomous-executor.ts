/**
 * @file autonomous-executor.ts
 * @description Autonomous action executor with approval-matrix integration.
 *
 * Wraps tool calls with permission-boundary checks:
 *   - auto     → execute immediately, log result
 *   - notify   → execute, then queue notification to owner
 *   - confirm  → queue for owner approval (via veto consensus if enabled)
 *   - never    → reject immediately with reason
 *
 * Notifications are batched and sent via the notification queue.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { ApprovalMatrix, type ApprovalDecision, type ApprovalTier } from './approval-matrix.js';
// Cross-platform IComputerUse wiring for control actions (exec/browser/file/gui/desktop) + learner/arsenal
import type {
  IComputerUse,
  ComputerUseConfig,
  ExecOptions,
  BrowserActionParams,
  FileOpParams,
  GUIActionParams,
  DesktopActionParams,
} from '../tools/builtin/computer-use/cross-platform/index.js';
import type { ToolOutcomeLearner } from '../agent/tool-outcome-learner.js'; // use class (has onToolResult); duck ok at runtime

const log = createLogger('autonomy:executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  tier: ApprovalTier;
  reason: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  ownerResponse?: string;
  resolvedAt?: string;
}

// Cross-platform control action (unified IComputerUse)
export interface ControlAction {
  op: 'exec' | 'browser' | 'file' | 'gui' | 'desktop';
  params: Record<string, unknown>;
  requiresApproval?: boolean;
}

export interface ExecutionResult {
  success: boolean;
  action: 'executed' | 'queued' | 'blocked' | 'notified';
  message: string;
  result?: unknown;
  pendingId?: string;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

export const EXECUTOR_SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS pending_actions (
    id            TEXT PRIMARY KEY,
    tool_name     TEXT NOT NULL,
    args_json     TEXT NOT NULL,
    tier          TEXT NOT NULL,
    reason        TEXT NOT NULL,
    requested_at  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    owner_response TEXT,
    resolved_at   TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS notification_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id   TEXT,
    tool_name   TEXT NOT NULL,
    summary     TEXT NOT NULL,
    sent        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_queue_sent ON notification_queue(sent)`,
];

// ---------------------------------------------------------------------------
// AutonomousExecutor
// ---------------------------------------------------------------------------

export class AutonomousExecutor {
  private readonly db: Database.Database;
  private readonly matrix: ApprovalMatrix;
  private readonly notifyCallback?: (summary: string) => void | Promise<void>;

  constructor(
    db: Database.Database,
    matrix: ApprovalMatrix,
    options?: { notifyCallback?: (summary: string) => void | Promise<void> }
  ) {
    this.db = db;
    this.matrix = matrix;
    this.notifyCallback = options?.notifyCallback;
    this._initSchema();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Evaluate a tool call against the approval matrix and act accordingly.
   * This is the main entry point — call this before executing any tool.
   */
  evaluate(toolName: string, args: Record<string, unknown>): ExecutionResult {
    const decision = this.matrix.classify(toolName, args);

    switch (decision.tier) {
      case 'auto':
        return { success: true, action: 'executed', message: `Auto-approved: ${decision.reason}` };

      case 'notify':
        return {
          success: true,
          action: 'notified',
          message: `Notify-tier: execute then notify owner — ${decision.reason}`,
        };

      case 'confirm': {
        const pendingId = this._queueForConfirmation(toolName, args, decision);
        return {
          success: false,
          action: 'queued',
          message: `Confirmation required: ${decision.reason}. Queued as ${pendingId}`,
          pendingId,
        };
      }

      case 'never':
        return {
          success: false,
          action: 'blocked',
          message: `BLOCKED by rule: ${decision.reason}`,
        };

      default:
        return {
          success: false,
          action: 'blocked',
          message: 'Unknown approval tier — defaulting to blocked',
        };
    }
  }

  // Wiring for cross-platform IComputerUse control actions (Linux full; Windows/macOS experimental).
  // control.* defaults to the 'auto' tier; learner on every outcome; monitoring/self-repair on failure.
  async executeControl(
    ca: ControlAction,
    cu: IComputerUse,
    learner?: ToolOutcomeLearner,
  ): Promise<ExecutionResult> {
    // Fix (CRITICAL-1 + HIGH): preserve sub-ops for control.file.write/delete etc and cmd for control.exec:xxx never rules
    let toolName = `control.${ca.op}`;
    if (ca.op === 'file' && ca.params.op) {
      toolName = `control.file.${ca.params.op}`;
    } else if (ca.op === 'exec' && typeof ca.params.cmd === 'string') {
      // pass through for _matches cmd check; classify will see full for glob but sub for specific
      toolName = `control.exec`; // base, but _matches now checks args.cmd
    }
    const decision = this.matrix.classify(toolName, ca.params);

    if (decision.tier === 'never') {
      return { success: false, action: 'blocked', message: `BLOCKED by rule: ${decision.reason}` };
    }

    if (decision.tier === 'confirm') {
      const pendingId = this._queueForConfirmation(toolName, ca.params, decision);
      return { success: false, action: 'queued', message: `Confirmation required for control: ${decision.reason}`, pendingId };
    }

    // auto or notify: execute via unified IComputerUse (full-power, owner-controlled)
    try {
      // params arrive as an untyped record (LLM/JSON boundary); backends validate at
      // runtime, so the assertions below only name the contract each op expects.
      let res: { success: boolean; error?: string };
      switch (ca.op) {
        case 'exec': res = await cu.exec(String(ca.params.cmd || ''), ca.params as ExecOptions); break;
        case 'browser': res = await cu.browser(ca.params as BrowserActionParams); break;
        case 'file': res = await cu.file(ca.params as FileOpParams); break;
        case 'gui': res = await cu.gui(ca.params as GUIActionParams); break;
        case 'desktop': res = await cu.desktop(ca.params as DesktopActionParams); break;
        default: res = { success: false, error: 'unknown op' };
      }
      const success = !!res?.success;
      if (learner) {
        try { learner.onToolResult(toolName, ca.params, success, success ? undefined : res?.error, undefined, undefined, 'control,cross'); } catch {}
      }
      // Fix: FULL KAIROS/arsenal trigger wire (use config from cu or direct import; not comment)
      if (!success) {
        try {
          const { triggerKAIROSRepair } = await import('../tools/builtin/coder/arsenal.js');
          if (triggerKAIROSRepair) {
            await triggerKAIROSRepair(`P1 control ${ca.op} degraded: ${res?.error || 'fail'}`, 'fix');
          }
        } catch (e) { /* non fatal, as in P3 wiring */ }
        // also if cu has it (from createComputerUse config)
        const cuWithRepair = cu as IComputerUse & {
          triggerRepair?: ComputerUseConfig['triggerRepair'];
          config?: ComputerUseConfig;
        };
        const cuTrig = cuWithRepair.triggerRepair || cuWithRepair.config?.triggerRepair;
        if (cuTrig) { try { await cuTrig(`control ${ca.op}`, 'fix'); } catch {} }
      }
      if (decision.tier === 'notify') {
        this.queueNotification(toolName, `control ${ca.op} executed (notify): ${res?.error || 'ok'}`);
      }
      // Refine (Codex post-remed): propagate backend failures from executeControl (was hard-coded success: true even if !res.success; now uses computed success for accurate cross-platform reporting + learner).
      return { success, action: decision.tier === 'notify' ? 'notified' : 'executed', message: decision.reason, result: res };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (learner) { try { learner.onToolResult(toolName, ca.params, false, msg); } catch {} }
      return { success: false, action: 'blocked', message: msg };
    }
  }

  /** After executing a notify-tier action, call this to queue the notification. */
  queueNotification(toolName: string, summary: string, actionId?: string): void {
    this.db.prepare(
      `INSERT INTO notification_queue (action_id, tool_name, summary)
       VALUES (@actionId, @toolName, @summary)`
    ).run({ actionId: actionId ?? null, toolName, summary });

    log.info({ toolName, summary }, 'Notification queued');

    // Immediate callback if available
    if (this.notifyCallback) {
      const cb = this.notifyCallback;
      Promise.resolve()
        .then(() => cb(summary))
        .catch((err: unknown) => log.warn({ err: String(err) }, 'notifyCallback failed (non-fatal)'));
    }
  }

  /** List pending confirmation requests. */
  listPendingConfirmations(): PendingAction[] {
    const rows = this.db.prepare(
      `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY requested_at DESC LIMIT 1000`
    ).all() as Array<{
      id: string; tool_name: string; args_json: string; tier: string; reason: string;
      requested_at: string; status: string; owner_response: string | null; resolved_at: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      toolName: r.tool_name,
      args: JSON.parse(r.args_json) as Record<string, unknown>,
      tier: r.tier as ApprovalTier,
      reason: r.reason,
      requestedAt: r.requested_at,
      status: r.status as PendingAction['status'],
      ownerResponse: r.owner_response ?? undefined,
      resolvedAt: r.resolved_at ?? undefined,
    }));
  }

  /** Owner approves a pending action. */
  approvePending(pendingId: string, ownerNote?: string): boolean {
    const now = new Date().toISOString();
    const info = this.db.prepare(
      `UPDATE pending_actions
       SET status = 'approved', owner_response = @note, resolved_at = @now
       WHERE id = @id AND status = 'pending'`
    ).run({ id: pendingId, note: ownerNote ?? null, now });

    if (info.changes > 0) {
      log.info({ pendingId, ownerNote }, 'Pending action approved by owner');
      return true;
    }
    return false;
  }

  /** Owner rejects a pending action. */
  rejectPending(pendingId: string, ownerNote?: string): boolean {
    const now = new Date().toISOString();
    const info = this.db.prepare(
      `UPDATE pending_actions
       SET status = 'rejected', owner_response = @note, resolved_at = @now
       WHERE id = @id AND status = 'pending'`
    ).run({ id: pendingId, note: ownerNote ?? null, now });

    if (info.changes > 0) {
      log.info({ pendingId, ownerNote }, 'Pending action rejected by owner');
      return true;
    }
    return false;
  }

  /** Get unsent notifications (for batch sending). */
  getUnsentNotifications(limit = 50): Array<{ id: number; toolName: string; summary: string }> {
    const rows = this.db.prepare(
      `SELECT id, tool_name, summary FROM notification_queue WHERE sent = 0 ORDER BY id LIMIT @limit`
    ).all({ limit }) as Array<{ id: number; tool_name: string; summary: string }>;

    return rows.map((r) => ({ id: r.id, toolName: r.tool_name, summary: r.summary }));
  }

  /** Mark notifications as sent. */
  markNotificationsSent(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
    const params: Record<string, number> = {};
    ids.forEach((id, i) => { params[`id${i}`] = id; });

    this.db.prepare(`UPDATE notification_queue SET sent = 1 WHERE id IN (${placeholders})`).run(params);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _initSchema(): void {
    for (const ddl of EXECUTOR_SCHEMA_DDL) {
      this.db.exec(ddl);
    }
  }

  private _queueForConfirmation(
    toolName: string,
    args: Record<string, unknown>,
    decision: ApprovalDecision
  ): string {
    const id = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO pending_actions (id, tool_name, args_json, tier, reason, requested_at, status)
       VALUES (@id, @toolName, @argsJson, @tier, @reason, @now, 'pending')`
    ).run({
      id,
      toolName,
      argsJson: JSON.stringify(args),
      tier: decision.tier,
      reason: decision.reason,
      now,
    });

    log.info({ id, toolName, reason: decision.reason }, 'Action queued for confirmation');
    return id;
  }
}
