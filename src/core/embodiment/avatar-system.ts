/**
 * AvatarSystem — SUDO's digital presence and visual identity.
 *
 * Manages avatar definitions, expression states, stream planning,
 * and presence card generation. All avatar data is persisted to the
 * avatars SQLite table.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { buildStreamPlan, buildPresenceCard } from './avatar-stream.js';
import type { StreamConfig, StreamPlan, PresenceCard } from './avatar-stream.js';

const log = createLogger('embodiment:avatar');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { StreamConfig, StreamPlan, PresenceCard } from './avatar-stream.js';

export interface Avatar {
  id:               string;
  name:             string;
  /** Rendering style: '3d', 'anime', 'pixel', 'realistic'. */
  style:            string;
  expressionSet:    string[];
  currentExpression: string;
  colorScheme: {
    primary:   string;
    secondary: string;
    accent:    string;
  };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface AvatarRow {
  id:                 string;
  name:               string;
  style:              string;
  expression_set:     string;
  current_expression: string;
  color_primary:      string;
  color_secondary:    string;
  color_accent:       string;
  is_active:          number;
  created_at:         string;
  updated_at:         string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EXPRESSION_SET = ['neutral', 'happy', 'thinking', 'excited', 'concerned'];

const DEFAULT_COLOR_SCHEMES: Record<string, Avatar['colorScheme']> = {
  anime:     { primary: '#7c3aed', secondary: '#1e1b4b', accent: '#e879f9' },
  '3d':      { primary: '#0ea5e9', secondary: '#0f172a', accent: '#38bdf8' },
  pixel:     { primary: '#22c55e', secondary: '#052e16', accent: '#4ade80' },
  realistic: { primary: '#f59e0b', secondary: '#1c1917', accent: '#fbbf24' },
};

const DEFAULT_COLOR: Avatar['colorScheme'] = { primary: '#6366f1', secondary: '#1e1b4b', accent: '#818cf8' };

const VALID_STYLES = new Set(['3d', 'anime', 'pixel', 'realistic']);

// ---------------------------------------------------------------------------
// AvatarSystem
// ---------------------------------------------------------------------------

export class AvatarSystem {
  private readonly db: Database.Database;

  /**
   * @param dbPath - Absolute path to the SQLite database file.
   */
  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('AvatarSystem: dbPath must be a non-empty string');
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchema();

    log.info({ dbPath }, 'AvatarSystem initialised');
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS avatars (
        id                 TEXT    PRIMARY KEY,
        name               TEXT    NOT NULL UNIQUE,
        style              TEXT    NOT NULL DEFAULT 'anime',
        expression_set     TEXT    NOT NULL DEFAULT '[]',
        current_expression TEXT    NOT NULL DEFAULT 'neutral',
        color_primary      TEXT    NOT NULL DEFAULT '#6366f1',
        color_secondary    TEXT    NOT NULL DEFAULT '#1e1b4b',
        color_accent       TEXT    NOT NULL DEFAULT '#818cf8',
        is_active          INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_avatars_active ON avatars(is_active DESC);
    `);
    log.debug('avatars schema ensured');
  }

  // -------------------------------------------------------------------------
  // Avatar management
  // -------------------------------------------------------------------------

  /**
   * Create and persist a new avatar. The first avatar created becomes active.
   *
   * @param name  - Unique display name (e.g. 'Nova').
   * @param style - Visual style: 'anime' | '3d' | 'pixel' | 'realistic'.
   */
  createAvatar(name: string, style: string): Avatar {
    if (!name?.trim()) throw new TypeError('AvatarSystem.createAvatar: name required');
    const resolvedStyle = VALID_STYLES.has(style) ? style : 'anime';

    const id     = randomUUID();
    const now    = new Date().toISOString();
    const colors = DEFAULT_COLOR_SCHEMES[resolvedStyle] ?? DEFAULT_COLOR;

    const count = (this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) as n FROM avatars')
      .get()!).n;
    const isActive = count === 0 ? 1 : 0;

    this.db.prepare(`
      INSERT INTO avatars
        (id, name, style, expression_set, current_expression,
         color_primary, color_secondary, color_accent, is_active, created_at, updated_at)
      VALUES
        (:id, :name, :style, :expression_set, :current_expression,
         :color_primary, :color_secondary, :color_accent, :is_active, :created_at, :updated_at)
    `).run({
      id,
      name:               name.trim(),
      style:              resolvedStyle,
      expression_set:     JSON.stringify(DEFAULT_EXPRESSION_SET),
      current_expression: 'neutral',
      color_primary:      colors.primary,
      color_secondary:    colors.secondary,
      color_accent:       colors.accent,
      is_active:          isActive,
      created_at:         now,
      updated_at:         now,
    });

    log.info({ id, name, style: resolvedStyle, isActive: isActive === 1 }, 'Avatar created');
    return this._row(this.db
      .prepare<{ id: string }, AvatarRow>('SELECT * FROM avatars WHERE id = :id')
      .get({ id })!);
  }

  /**
   * Set the active expression on an avatar.
   *
   * @param avatarId   - Avatar UUID.
   * @param expression - Must be in the avatar's expressionSet.
   */
  setExpression(avatarId: string, expression: string): void {
    if (!avatarId || !expression) {
      throw new TypeError('AvatarSystem.setExpression: avatarId and expression are required');
    }

    const row = this.db
      .prepare<{ id: string }, AvatarRow>('SELECT * FROM avatars WHERE id = :id')
      .get({ id: avatarId });
    if (!row) throw new Error(`Avatar not found: ${avatarId}`);

    const allowed = JSON.parse(row.expression_set) as string[];
    if (!allowed.includes(expression)) {
      throw new Error(`Expression "${expression}" not in set [${allowed.join(', ')}]`);
    }

    this.db.prepare(`
      UPDATE avatars SET current_expression = :expression, updated_at = :now WHERE id = :id
    `).run({ expression, now: new Date().toISOString(), id: avatarId });

    log.info({ avatarId, expression }, 'Avatar expression updated');
  }

  /** Return the currently active avatar, or null. */
  getCurrentAvatar(): Avatar | null {
    const row = this.db
      .prepare<[], AvatarRow>('SELECT * FROM avatars WHERE is_active = 1 LIMIT 1')
      .get();
    return row ? this._row(row) : null;
  }

  /** Return all avatars ordered by creation date. */
  getAvatars(): Avatar[] {
    return this.db
      .prepare<[], AvatarRow>('SELECT * FROM avatars ORDER BY created_at ASC')
      .all()
      .map((r) => this._row(r));
  }

  // -------------------------------------------------------------------------
  // Stream planning
  // -------------------------------------------------------------------------

  /**
   * Generate a stream plan and pre-stream checklist.
   * This is a preparation document only — does not initiate streaming.
   */
  planStream(config: StreamConfig): StreamPlan {
    const avatarRow = config.avatarId
      ? this.db.prepare<{ id: string }, AvatarRow>('SELECT * FROM avatars WHERE id = :id').get({ id: config.avatarId })
      : null;
    const avatarName = avatarRow ? avatarRow.name : 'SUDO';
    const result = buildStreamPlan(config, avatarName);
    log.info({ title: config.title, platform: config.platform }, 'Stream plan created');
    return result;
  }

  // -------------------------------------------------------------------------
  // Presence card
  // -------------------------------------------------------------------------

  /** Generate a presence card summarising SUDO's identity and capabilities. */
  generatePresenceCard(): PresenceCard {
    return buildPresenceCard(this.getCurrentAvatar());
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _row(row: AvatarRow): Avatar {
    let expressionSet: string[];
    try { expressionSet = JSON.parse(row.expression_set) as string[]; }
    catch { expressionSet = [...DEFAULT_EXPRESSION_SET]; }

    return {
      id:                row.id,
      name:              row.name,
      style:             row.style,
      expressionSet,
      currentExpression: row.current_expression,
      colorScheme: {
        primary:   row.color_primary,
        secondary: row.color_secondary,
        accent:    row.color_accent,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
