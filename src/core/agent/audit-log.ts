/**
 * @file audit-log.ts
 * @description AuditLog — append-only record of significant agent actions.
 *
 * Every event is written as a single JSON line to data/audit.log.
 * The file is NEVER rewritten — only appended to. This prevents
 * self-erasure of history. If the log exceeds 10 MB it is rotated
 * to audit.log.1 and a fresh file is started.
 */

import fs from 'fs';
import path from 'path';
import { genId } from '../shared/index.js';
import { createLogger } from '../shared/index.js';

const log = createLogger('agent:audit-log');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SUMMARY_LENGTH = 200;
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditEventType =
  | 'session_start'
  | 'session_end'
  | 'tool_call'
  | 'tool_result'
  | 'compaction'
  | 'loop_abort'
  | 'coordinator_request'
  | 'coordinator_approved'
  | 'coordinator_rejected'
  | 'agent_spawned'
  | 'agent_completed'
  | 'dream_started'
  | 'dream_completed'
  | 'kairos_observation'
  | 'frustration_detected'
  | 'decision_budget_warning';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: AuditEventType;
  sessionId?: string;
  toolName?: string;
  /** Max 200 characters. */
  summary: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

/**
 * Append-only audit log stored as newline-delimited JSON.
 *
 * Thread safety: Node.js is single-threaded so synchronous writes are safe
 * within a single process. appendFileSync is used to ensure the write
 * completes before returning.
 */
export class AuditLog {
  private readonly logPath: string;

  constructor(logPath = 'data/audit.log') {
    this.logPath = logPath;
    this._ensureDir();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append a new event to the log.
   * Automatically assigns id and timestamp. Truncates summary if needed.
   * Rotates the log file if it exceeds MAX_LOG_BYTES.
   *
   * @param event - Event data without id/timestamp (auto-generated).
   * @returns The completed AuditEvent as stored.
   */
  append(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    this._maybeRotate();

    const full: AuditEvent = {
      id: genId(),
      timestamp: new Date().toISOString(),
      ...event,
      summary: event.summary.slice(0, MAX_SUMMARY_LENGTH),
    };

    const line = JSON.stringify(full) + '\n';

    try {
      fs.appendFileSync(this.logPath, line, 'utf8');
    } catch (err) {
      log.error({ err, logPath: this.logPath }, 'AuditLog: failed to append event');
    }

    return full;
  }

  /**
   * Return the last N events from the log.
   * Reads the entire file and returns the tail — intended for health checks
   * and display, not bulk processing.
   *
   * @param count - Number of recent events to return. Default: 50.
   */
  recent(count = 50): AuditEvent[] {
    const all = this._readAll();
    return all.slice(-count);
  }

  /**
   * Count events by type that were recorded within the last N hours.
   *
   * @param hours - Lookback window in hours. Default: 24.
   * @returns Object mapping each AuditEventType to its count (0 if none).
   */
  countByType(hours = 24): Record<AuditEventType, number> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const all = this._readAll();

    const counts = {} as Record<AuditEventType, number>;

    for (const event of all) {
      const ts = Date.parse(event.timestamp);
      if (isNaN(ts) || ts < cutoff) continue;
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    }

    return counts;
  }

  /**
   * Return all events associated with a specific session ID.
   *
   * @param sessionId - Session ID to filter on.
   */
  forSession(sessionId: string): AuditEvent[] {
    return this._readAll().filter((e) => e.sessionId === sessionId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Ensure the data directory exists. */
  private _ensureDir(): void {
    const dir = path.dirname(this.logPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error({ err, dir }, 'AuditLog: failed to create data directory');
    }
  }

  /**
   * Rotate the log file if it exceeds MAX_LOG_BYTES.
   * Moves current file to <logPath>.1 (overwrites previous rotation).
   */
  private _maybeRotate(): void {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size >= MAX_LOG_BYTES) {
        const rotated = `${this.logPath}.1`;
        fs.renameSync(this.logPath, rotated);
        log.info({ rotated, sizeBytes: stat.size }, 'AuditLog: rotated log file');
      }
    } catch {
      // File doesn't exist yet — that's fine.
    }
  }

  /**
   * Read and parse all events from the current log file.
   * Silently skips lines that fail JSON parsing.
   */
  private _readAll(): AuditEvent[] {
    let content: string;
    try {
      content = fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return [];
    }

    const events: AuditEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        log.warn({ line: trimmed.slice(0, 80) }, 'AuditLog: skipping malformed line');
      }
    }

    return events;
  }
}
