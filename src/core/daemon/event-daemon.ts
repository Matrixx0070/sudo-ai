/**
 * @file event-daemon.ts
 * @description Persistent Event Daemon — always-on process that reacts to real-time events.
 *
 * Monitors on each poll cycle (delegated to event-detectors.ts):
 *   - New YouTube comments (requires YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID)
 *   - Consciousness thought-rate anomalies
 *   - System health / heap pressure
 *   - API quota budget warnings
 *   - Subscriber milestones
 *
 * Custom events can be emitted at any time via emit().
 * All events are persisted to SQLite for audit and replay.
 *
 * Environment:
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key
 *   YOUTUBE_CHANNEL_ID   — Channel ID (e.g. UCxxxxxx)
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initDaemonSchema,
  rowToEvent,
  type DaemonEvent,
  type DaemonEventRow,
  type EventPriority,
  type EventStats,
} from './event-daemon-schema.js';
import {
  detectYouTubeComments,
  detectConsciousness,
  detectSystemHealth,
  detectQuotaWarning,
  detectSubMilestones,
  type DetectionState,
  type PersistFn,
} from './event-detectors.js';

export type { DaemonEvent, EventPriority, EventStats } from './event-daemon-schema.js';

const log = createLogger('daemon:event-daemon');

// ---------------------------------------------------------------------------
// EventHandler type
// ---------------------------------------------------------------------------

export interface EventHandler {
  eventType: string;
  handler: (event: DaemonEvent) => Promise<string>;
  priority: number;
}

// ---------------------------------------------------------------------------
// EventDaemon
// ---------------------------------------------------------------------------

export class EventDaemon {
  private readonly db: Database.Database;
  private readonly handlers: Map<string, EventHandler[]> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly detectionState: DetectionState = {
    lastCommentFetch:       0,
    lastSubMilestoneFetch:  0,
    lastSubCount:           0,
    lastThoughtCount:       0,
    knownCommentIds:        new Set(),
  };

  constructor(private readonly dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('EventDaemon: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    initDaemonSchema(this.db);
    log.info({ dbPath }, 'EventDaemon initialised');
  }

  // -------------------------------------------------------------------------
  // Handler registration
  // -------------------------------------------------------------------------

  on(eventType: string, handler: EventHandler['handler'], priority = 5): void {
    if (!eventType?.trim()) throw new Error('eventType is required');
    if (typeof handler !== 'function') throw new Error('handler must be a function');
    const entry: EventHandler = { eventType: eventType.trim(), handler, priority };
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(entry);
    existing.sort((a, b) => b.priority - a.priority);
    this.handlers.set(eventType, existing);
    log.debug({ eventType, priority }, 'Handler registered');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(pollIntervalMs = 60_000): void {
    if (this.running) {
      log.warn('EventDaemon.start() called while already running — ignoring');
      return;
    }
    if (pollIntervalMs < 5_000) throw new Error('pollIntervalMs must be >= 5000');

    this.running = true;
    log.info({ pollIntervalMs }, 'EventDaemon starting');

    void this._cycle();
    this.interval = setInterval(() => void this._cycle(), pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    log.info('EventDaemon stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Custom event emission
  // -------------------------------------------------------------------------

  emit(type: string, data: unknown, priority: EventPriority = 'medium'): void {
    if (!type?.trim()) throw new Error('type is required');
    const event = this._persistEvent({ type: type.trim(), source: 'custom', data, priority });
    log.info({ eventId: event.id, type, priority }, 'Custom event emitted');
    void this._dispatchEvent(event);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getRecentEvents(limit = 50): DaemonEvent[] {
    const n = Math.min(Math.max(1, limit), 500);
    const rows = this.db
      .prepare<[number], DaemonEventRow>(
        `SELECT * FROM daemon_events ORDER BY detected_at DESC LIMIT ?`,
      )
      .all(n);
    return rows.map(rowToEvent);
  }

  getUnhandledEvents(): DaemonEvent[] {
    const rows = this.db
      .prepare<[], DaemonEventRow>(
        `SELECT * FROM daemon_events WHERE handled = 0 ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         detected_at ASC`,
      )
      .all();
    return rows.map(rowToEvent);
  }

  getStats(): EventStats {
    const total =
      (this.db.prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM daemon_events`).get()?.count) ?? 0;
    const handled =
      (this.db.prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM daemon_events WHERE handled = 1`).get()?.count) ?? 0;
    const byTypeRows = this.db
      .prepare<[], { type: string; count: number }>(
        `SELECT type, COUNT(*) as count FROM daemon_events GROUP BY type`,
      )
      .all();
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.type] = r.count;
    return { totalEvents: total, handled, unhandled: total - handled, byType };
  }

  // -------------------------------------------------------------------------
  // Private — detection cycle
  // -------------------------------------------------------------------------

  private async _cycle(): Promise<void> {
    try {
      const events = await this._detectEvents();
      for (const event of events) {
        void this._dispatchEvent(event);
      }
      log.debug({ detected: events.length }, 'Detection cycle complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Detection cycle error');
    }
  }

  private async _detectEvents(): Promise<DaemonEvent[]> {
    const persist: PersistFn = (p) => this._persistEvent(p);
    const results = await Promise.allSettled([
      detectYouTubeComments(this.detectionState, persist),
      Promise.resolve(detectConsciousness(this.detectionState, persist)),
      Promise.resolve(detectSystemHealth(persist)),
      Promise.resolve(detectQuotaWarning(persist)),
      detectSubMilestones(this.detectionState, persist),
    ]);

    const events: DaemonEvent[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') events.push(...r.value);
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Persist + dispatch
  // -------------------------------------------------------------------------

  private _persistEvent(partial: {
    type: string;
    source: string;
    data: unknown;
    priority: EventPriority;
  }): DaemonEvent {
    const event: DaemonEvent = {
      id:         randomUUID(),
      type:       partial.type,
      source:     partial.source,
      data:       partial.data,
      priority:   partial.priority,
      handled:    false,
      detectedAt: new Date().toISOString(),
    };
    this.db
      .prepare<[string, string, string, string, string]>(
        `INSERT INTO daemon_events (id, type, source, data, priority) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.type, event.source, JSON.stringify(event.data), event.priority);
    return event;
  }

  private async _dispatchEvent(event: DaemonEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? this.handlers.get('*') ?? [];
    if (handlers.length === 0) return;

    for (const h of handlers) {
      try {
        const actionDescription = await h.handler(event);
        this.db
          .prepare<[string, string]>(
            `UPDATE daemon_events SET handled = 1, handler = ? WHERE id = ?`,
          )
          .run(actionDescription, event.id);
        log.info({ eventId: event.id, type: event.type, action: actionDescription }, 'Event handled');
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ eventId: event.id, err: msg }, 'Event handler error');
      }
    }
  }
}
