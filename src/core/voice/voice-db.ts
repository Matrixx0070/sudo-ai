/**
 * VoiceDB — low-level SQLite helpers for the voice_messages table.
 * Extracted from VoiceEngine to keep files under 300 lines.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('voice:db');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VoiceMessage {
  id:        string;
  text:      string;
  audioPath?: string;
  voice:     string;
  duration?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

export interface VoiceMessageRow {
  id:          string;
  text:        string;
  audio_path:  string | null;
  voice:       string;
  duration_ms: number | null;
  created_at:  string;
}

// ---------------------------------------------------------------------------
// VoiceDB
// ---------------------------------------------------------------------------

export class VoiceDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchema();
    log.debug({ dbPath }, 'VoiceDB ready');
  }

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_messages (
        id         TEXT    PRIMARY KEY,
        text       TEXT    NOT NULL,
        audio_path TEXT,
        voice      TEXT    NOT NULL DEFAULT 'default',
        duration_ms INTEGER,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_voice_messages_created
        ON voice_messages(created_at DESC);
    `);
  }

  /** Persist a voice message and return it. */
  save(
    text:       string,
    voice:      string,
    audioPath?: string,
    durationMs?: number,
  ): VoiceMessage {
    const id  = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO voice_messages (id, text, audio_path, voice, duration_ms, created_at)
      VALUES (:id, :text, :audio_path, :voice, :duration_ms, :created_at)
    `).run({
      id,
      text,
      audio_path:  audioPath  ?? null,
      voice,
      duration_ms: durationMs ?? null,
      created_at:  now,
    });

    log.debug({ id }, 'Voice message saved');

    return {
      id,
      text,
      audioPath,
      voice,
      duration:  durationMs,
      createdAt: now,
    };
  }

  /** Return recent messages, newest first. */
  recent(limit: number): VoiceMessage[] {
    return this.db
      .prepare<{ limit: number }, VoiceMessageRow>(
        'SELECT * FROM voice_messages ORDER BY created_at DESC LIMIT :limit',
      )
      .all({ limit })
      .map(rowToMessage);
  }
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

function rowToMessage(row: VoiceMessageRow): VoiceMessage {
  return {
    id:        row.id,
    text:      row.text,
    audioPath: row.audio_path ?? undefined,
    voice:     row.voice,
    duration:  row.duration_ms ?? undefined,
    createdAt: row.created_at,
  };
}
