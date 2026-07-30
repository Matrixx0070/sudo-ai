/**
 * @file mission-control.ts
 * @description TX9 v1 — missions as the unit of work. A mission is a named
 * multi-phase run with a LIVING CARD (one Telegram message, edited in place)
 * showing phases, artifacts as they complete, and the current checkpoint.
 * Decision points ride the TX10 checkpoint protocol (Approve / Redirect /
 * Abort — persisted artifacts, owner taps, HOLD on timeout).
 *
 * Transport: forum topics need a supergroup with topics enabled — an operator
 * step (TELEGRAM_MISSION_GROUP_ID). Absent that, the card lands in the owner
 * DM; the mission model is identical. Flag: SUDO_TG_MISSION_CONTROL=1
 * (default OFF — activation is the operator's call).
 *
 * Persistence: missions + phases in sqlite (data/missions.db, WAL) so a
 * restart re-attaches to running missions instead of orphaning their cards.
 */

import { randomUUID } from 'node:crypto';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { getCheckpointProtocol, } from './checkpoint-registry.js';
import { CHECKPOINT_HOLD } from './checkpoint-protocol.js';

const log = createLogger('channels:mission');

export function missionControlEnabled(): boolean {
  return process.env['SUDO_TG_MISSION_CONTROL'] === '1';
}

export type MissionStatus = 'running' | 'awaiting_decision' | 'done' | 'aborted' | 'failed';
export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface MissionPhase {
  name: string;
  status: PhaseStatus;
  /** One-line result/artifact note shown on the card once terminal. */
  note?: string;
}

export interface Mission {
  id: string;
  title: string;
  status: MissionStatus;
  phases: MissionPhase[];
  /** Card location: chat + message id once the card is posted. */
  chatId?: string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Card transport seam — prod wires the Telegram adapter (post + edit). */
export interface MissionCardTransport {
  /** Post the initial card; returns {chatId, messageId}. */
  post(text: string): Promise<{ chatId: string; messageId: string }>;
  /** Edit the card in place. */
  edit(chatId: string, messageId: string, text: string): Promise<void>;
}

const PHASE_ICON: Record<PhaseStatus, string> = {
  pending: '·', running: '✻', done: '✓', failed: '✗', skipped: '↷',
};
const STATUS_LINE: Record<MissionStatus, string> = {
  running: '🔶 running',
  awaiting_decision: '🛂 awaiting your decision',
  done: '✅ complete',
  aborted: '⏹ aborted',
  failed: '🔴 failed',
};

/** Pure renderer — the living card body (markdown). */
export function renderMissionCard(m: Mission): string {
  const lines: string[] = [];
  lines.push(`🎯 **Mission: ${m.title}**`);
  lines.push(STATUS_LINE[m.status]);
  lines.push('');
  for (const p of m.phases) {
    lines.push(`${PHASE_ICON[p.status]} ${p.name}${p.note ? ` — ${p.note}` : ''}`);
  }
  return lines.join('\n');
}

export class MissionControl {
  private readonly db: Database;
  private readonly transport: MissionCardTransport | null;

  constructor(dbPath: string, transport?: MissionCardTransport) {
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        status     TEXT NOT NULL,
        phases     TEXT NOT NULL,
        chat_id    TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    this.transport = transport ?? null;
  }

  /** Start a mission: persist, post the living card (best-effort). */
  async start(title: string, phaseNames: string[]): Promise<Mission> {
    const m: Mission = {
      id: randomUUID(),
      title,
      status: 'running',
      phases: phaseNames.map((name, i) => ({ name, status: i === 0 ? 'running' : 'pending' })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO missions (id, title, status, phases) VALUES (?, ?, ?, ?)')
      .run(m.id, m.title, m.status, JSON.stringify(m.phases));
    if (this.transport) {
      try {
        const { chatId, messageId } = await this.transport.post(renderMissionCard(m));
        m.chatId = chatId;
        m.messageId = messageId;
        this.db.prepare('UPDATE missions SET chat_id=?, message_id=? WHERE id=?').run(chatId, messageId, m.id);
      } catch (err) {
        log.warn({ missionId: m.id, err: String(err) }, 'Mission card post failed — mission continues uncarded');
      }
    }
    log.info({ missionId: m.id, title, phases: phaseNames.length }, 'Mission started');
    return m;
  }

  /** Update a phase (status/note), refresh the card. */
  async updatePhase(missionId: string, phaseName: string, status: PhaseStatus, note?: string): Promise<void> {
    const m = this.get(missionId);
    if (!m) return;
    const phase = m.phases.find((p) => p.name === phaseName);
    if (!phase) return;
    phase.status = status;
    if (note !== undefined) phase.note = note;
    // Auto-advance: when a phase lands, the next pending phase starts running.
    if (status === 'done') {
      const next = m.phases.find((p) => p.status === 'pending');
      if (next) next.status = 'running';
    }
    this._save(m);
    await this._refreshCard(m);
  }

  /**
   * Decision point: ask Approve / Redirect / Abort through TX10 and settle the
   * mission accordingly. HOLD (timeout / no protocol wired) keeps the mission
   * awaiting_decision — it NEVER silently continues (invariant 8).
   * Returns the decision string (or HOLD).
   */
  async checkpoint(missionId: string, question: string, timeoutMs?: number): Promise<string> {
    const m = this.get(missionId);
    if (!m) return CHECKPOINT_HOLD;
    m.status = 'awaiting_decision';
    this._save(m);
    await this._refreshCard(m);

    const proto = getCheckpointProtocol();
    if (!proto) {
      log.warn({ missionId }, 'No checkpoint protocol wired — mission HOLDs');
      return CHECKPOINT_HOLD;
    }
    const result = await proto.request({
      kind: `mission:${m.title}`,
      question,
      options: ['Approve', 'Redirect', 'Abort'],
      context: { missionId },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    if (result.decision === 'Approve') {
      m.status = 'running';
    } else if (result.decision === 'Abort') {
      m.status = 'aborted';
    } else if (result.decision === 'Redirect') {
      // The redirect INSTRUCTION arrives as the owner's next message; the
      // mission stays awaiting_decision until the caller applies it.
      m.status = 'awaiting_decision';
    }
    // HOLD: stays awaiting_decision.
    this._save(m);
    await this._refreshCard(m);
    return result.decision;
  }

  /** Terminal states. */
  async complete(missionId: string, note?: string): Promise<void> {
    await this._finish(missionId, 'done', note);
  }
  async fail(missionId: string, note?: string): Promise<void> {
    await this._finish(missionId, 'failed', note);
  }

  get(missionId: string): Mission | null {
    const r = this.db.prepare('SELECT * FROM missions WHERE id=?').get(missionId) as Record<string, unknown> | undefined;
    return r ? this._row(r) : null;
  }

  /** Non-terminal missions (restart re-attach surface). */
  getActive(): Mission[] {
    return (this.db.prepare("SELECT * FROM missions WHERE status IN ('running','awaiting_decision') ORDER BY created_at").all() as Array<Record<string, unknown>>)
      .map((r) => this._row(r));
  }

  close(): void { this.db.close(); }

  private async _finish(missionId: string, status: MissionStatus, note?: string): Promise<void> {
    const m = this.get(missionId);
    if (!m) return;
    m.status = status;
    const running = m.phases.find((p) => p.status === 'running');
    if (running) {
      running.status = status === 'done' ? 'done' : 'failed';
      if (note !== undefined) running.note = note;
    }
    this._save(m);
    await this._refreshCard(m);
    log.info({ missionId, status }, 'Mission finished');
  }

  private _save(m: Mission): void {
    m.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE missions SET status=?, phases=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(m.status, JSON.stringify(m.phases), m.id);
  }

  private async _refreshCard(m: Mission): Promise<void> {
    if (!this.transport || !m.chatId || !m.messageId) return;
    try {
      await this.transport.edit(m.chatId, m.messageId, renderMissionCard(m));
    } catch (err) {
      log.debug({ missionId: m.id, err: String(err) }, 'Mission card edit failed (non-fatal)');
    }
  }

  private _row(r: Record<string, unknown>): Mission {
    return {
      id: r['id'] as string,
      title: r['title'] as string,
      status: r['status'] as MissionStatus,
      phases: JSON.parse(r['phases'] as string) as MissionPhase[],
      ...(r['chat_id'] ? { chatId: r['chat_id'] as string } : {}),
      ...(r['message_id'] ? { messageId: r['message_id'] as string } : {}),
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}
