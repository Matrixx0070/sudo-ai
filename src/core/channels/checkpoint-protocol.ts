/**
 * @file checkpoint-protocol.ts
 * @description TX10 — the formal "agent asks, owner taps" checkpoint seam,
 * reused by mission control (TX9) and the deploy/board/succession gates
 * (TX19/TX24/TX26).
 *
 * Harness-enforced (CLAUDE.md invariant 8): a checkpoint unblocks ONLY when a
 * persisted decision artifact exists. The decision row is written BEFORE the
 * waiting promise resolves; a timeout leaves the checkpoint pending and
 * resolves the waiter with HOLD — never an auto-approve. Restart-safe: pending
 * checkpoints survive in sqlite and can be re-listed / re-decided; a decision
 * arriving after restart still lands in the store even though the original
 * in-process waiter is gone.
 *
 * Transport-agnostic: the prompt goes out through an injected sender (the
 * Telegram owner-DM adapter in prod); callback routing follows the
 * telegram-run-controls prefix convention (`tx10:cp:`).
 */

import { randomUUID } from 'node:crypto';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:checkpoint');

/** Callback-data prefix for checkpoint option buttons. */
export const CHECKPOINT_CALLBACK_PREFIX = 'tx10:cp:';

/** Terminal HOLD decision used for timeouts — a non-decision that never unblocks work. */
export const CHECKPOINT_HOLD = 'HOLD' as const;

export interface CheckpointRequest {
  /** Which gate is asking (e.g. 'mission:phase-2', 'tx19:deploy'). */
  kind: string;
  /** The question shown to the owner. */
  question: string;
  /** Tap options, 1-8 (Telegram keyboard row limits). First = primary. */
  options: string[];
  /** Free-form context persisted with the artifact (mission id, diff refs…). */
  context?: Record<string, unknown>;
  /** How long the in-process waiter holds on before resolving HOLD. Default 10 min. */
  timeoutMs?: number;
}

export interface CheckpointDecision {
  checkpointId: string;
  /** The chosen option verbatim, or CHECKPOINT_HOLD on timeout. */
  decision: string;
  /** True when this resolution came from a persisted tap; false for HOLD timeouts. */
  decided: boolean;
}

export interface CheckpointRow {
  id: string;
  kind: string;
  question: string;
  options: string[];
  status: 'pending' | 'decided';
  decision: string | null;
  decidedBy: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Build the callback data for option `idx` of checkpoint `id`. */
export function checkpointCallbackData(id: string, idx: number): string {
  return `${CHECKPOINT_CALLBACK_PREFIX}${id}:${idx}`;
}

/** Parse checkpoint callback data; null when the prefix does not match. */
export function parseCheckpointCallback(data: string): { checkpointId: string; optionIndex: number } | null {
  if (!data.startsWith(CHECKPOINT_CALLBACK_PREFIX)) return null;
  const rest = data.slice(CHECKPOINT_CALLBACK_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const optionIndex = Number(rest.slice(sep + 1));
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  return { checkpointId: rest.slice(0, sep), optionIndex };
}

/** Sender seam — prod passes the Telegram owner-DM adapter. */
export interface CheckpointSender {
  (prompt: {
    checkpointId: string;
    kind: string;
    question: string;
    /** [{text, callbackData}] rows, one button per option. */
    buttons: Array<{ text: string; callbackData: string }>;
  }): Promise<void>;
}

export class CheckpointProtocol {
  private readonly db: Database;
  private readonly sender: CheckpointSender | null;
  private readonly waiters = new Map<string, { resolve: (d: CheckpointDecision) => void; timer: NodeJS.Timeout }>();

  constructor(dbPath: string, sender?: CheckpointSender) {
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        question    TEXT NOT NULL,
        options     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        decision    TEXT,
        decided_by  TEXT,
        context     TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        decided_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_status ON checkpoints(status);
    `);
    this.sender = sender ?? null;
  }

  /**
   * Ask the owner and wait. Resolves with the tapped option once the decision
   * artifact is PERSISTED, or with HOLD on timeout (checkpoint stays pending —
   * work stays blocked; the owner can still decide later via getPending()).
   */
  async request(req: CheckpointRequest): Promise<CheckpointDecision> {
    if (req.options.length < 1 || req.options.length > 8) {
      throw new Error(`checkpoint needs 1-8 options, got ${req.options.length}`);
    }
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO checkpoints (id, kind, question, options, context) VALUES (?, ?, ?, ?, ?)',
    ).run(id, req.kind, req.question, JSON.stringify(req.options), req.context ? JSON.stringify(req.context) : null);

    if (this.sender) {
      try {
        await this.sender({
          checkpointId: id,
          kind: req.kind,
          question: req.question,
          buttons: req.options.map((text, idx) => ({ text, callbackData: checkpointCallbackData(id, idx) })),
        });
      } catch (err) {
        // The artifact exists; delivery failure means the owner decides via a
        // later surface (pending list). Never unblock on a send error.
        log.warn({ checkpointId: id, err: String(err) }, 'Checkpoint prompt send failed — artifact persisted, awaiting decision via pending list');
      }
    } else {
      log.warn({ checkpointId: id, kind: req.kind }, 'No checkpoint sender wired — artifact persisted, awaiting out-of-band decision');
    }

    return new Promise<CheckpointDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        log.warn({ checkpointId: id, kind: req.kind }, 'Checkpoint timed out — resolving HOLD (still pending, never auto-approved)');
        resolve({ checkpointId: id, decision: CHECKPOINT_HOLD, decided: false });
      }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.waiters.set(id, { resolve, timer });
    });
  }

  /**
   * Record the owner's tap. Writes the decision artifact FIRST, then resolves
   * the in-process waiter (if any — post-restart decisions still persist).
   * Returns the decided option, or null when the callback is stale/invalid.
   */
  decide(checkpointId: string, optionIndex: number, decidedBy: string): string | null {
    const row = this.db.prepare('SELECT options, status FROM checkpoints WHERE id = ?').get(checkpointId) as
      | { options: string; status: string } | undefined;
    if (!row || row.status !== 'pending') return null;
    const options = JSON.parse(row.options) as string[];
    const decision = options[optionIndex];
    if (decision === undefined) return null;

    this.db.prepare(
      "UPDATE checkpoints SET status='decided', decision=?, decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending'",
    ).run(decision, decidedBy, checkpointId);

    const waiter = this.waiters.get(checkpointId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(checkpointId);
      waiter.resolve({ checkpointId, decision, decided: true });
    }
    log.info({ checkpointId, decision, decidedBy }, 'Checkpoint decided');
    return decision;
  }

  /** Route a raw callback-data string. True when it was a checkpoint tap. */
  handleCallback(data: string, decidedBy: string): boolean {
    const parsed = parseCheckpointCallback(data);
    if (!parsed) return false;
    this.decide(parsed.checkpointId, parsed.optionIndex, decidedBy);
    return true;
  }

  /** Pending checkpoints (restart-safe surface for re-prompt / /checkpoints). */
  getPending(): CheckpointRow[] {
    const rows = this.db.prepare("SELECT * FROM checkpoints WHERE status='pending' ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      kind: r['kind'] as string,
      question: r['question'] as string,
      options: JSON.parse(r['options'] as string) as string[],
      status: r['status'] as 'pending' | 'decided',
      decision: (r['decision'] as string | null) ?? null,
      decidedBy: (r['decided_by'] as string | null) ?? null,
      context: r['context'] ? JSON.parse(r['context'] as string) as Record<string, unknown> : null,
      createdAt: r['created_at'] as string,
      decidedAt: (r['decided_at'] as string | null) ?? null,
    }));
  }

  /** The persisted artifact for a checkpoint (audit surface). */
  get(checkpointId: string): CheckpointRow | null {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r['id'] as string,
      kind: r['kind'] as string,
      question: r['question'] as string,
      options: JSON.parse(r['options'] as string) as string[],
      status: r['status'] as 'pending' | 'decided',
      decision: (r['decision'] as string | null) ?? null,
      decidedBy: (r['decided_by'] as string | null) ?? null,
      context: r['context'] ? JSON.parse(r['context'] as string) as Record<string, unknown> : null,
      createdAt: r['created_at'] as string,
      decidedAt: (r['decided_at'] as string | null) ?? null,
    };
  }

  close(): void {
    for (const [, w] of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
    this.db.close();
  }
}
