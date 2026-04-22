/**
 * SocialIntelligenceDB — SQLite persistence layer for Social Intelligence.
 *
 * Tables:
 *   social_contacts      — people across platforms with relationship metadata
 *   social_interactions  — individual interaction events per contact
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { Contact, Interaction } from './social-intelligence.js';

const logger = createLogger('social-intelligence-db');

// Schema DDL

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS social_contacts (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    platform          TEXT NOT NULL DEFAULT 'other',
    platform_id       TEXT,
    relationship      TEXT NOT NULL DEFAULT 'unknown',
    trust_score       REAL NOT NULL DEFAULT 5.0,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    last_interaction  TEXT,
    notes             TEXT NOT NULL DEFAULT '',
    tags              TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sc_platform ON social_contacts(platform)`,
  `CREATE INDEX IF NOT EXISTS idx_sc_rel ON social_contacts(relationship)`,
  `CREATE INDEX IF NOT EXISTS idx_sc_trust ON social_contacts(trust_score)`,
  `CREATE INDEX IF NOT EXISTS idx_sc_name ON social_contacts(name)`,
  `CREATE TABLE IF NOT EXISTS social_interactions (
    id           TEXT PRIMARY KEY,
    contact_id   TEXT NOT NULL,
    type         TEXT NOT NULL,
    content      TEXT NOT NULL DEFAULT '',
    sentiment    TEXT NOT NULL DEFAULT 'neutral',
    platform     TEXT NOT NULL DEFAULT 'other',
    timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (contact_id) REFERENCES social_contacts(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_si_cid  ON social_interactions(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_si_ts   ON social_interactions(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_si_sent ON social_interactions(sentiment)`,
  `CREATE INDEX IF NOT EXISTS idx_si_type ON social_interactions(type)`,
];

// Row shapes

interface ContactRow {
  id: string;
  name: string;
  platform: string;
  platform_id: string | null;
  relationship: string;
  trust_score: number;
  interaction_count: number;
  last_interaction: string | null;
  notes: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface InteractionRow {
  id: string;
  contact_id: string;
  type: string;
  content: string;
  sentiment: string;
  platform: string;
  timestamp: string;
}

// Converters

function rowToContact(row: ContactRow): Contact {
  return {
    id:               row.id,
    name:             row.name,
    platform:         row.platform,
    platformId:       row.platform_id ?? undefined,
    relationship:     row.relationship as Contact['relationship'],
    trustScore:       row.trust_score,
    interactionCount: row.interaction_count,
    lastInteraction:  row.last_interaction ?? undefined,
    notes:            row.notes,
    tags:             safeParseJsonArray(row.tags),
  };
}

function rowToInteraction(row: InteractionRow): Interaction {
  return {
    id:        row.id,
    contactId: row.contact_id,
    type:      row.type,
    content:   row.content,
    sentiment: row.sentiment as Interaction['sentiment'],
    platform:  row.platform,
    timestamp: row.timestamp,
  };
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch { return []; }
}

// SocialIntelligenceDB

export class SocialIntelligenceDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SocialIntelligenceDB: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    logger.info({ dbPath }, 'SocialIntelligenceDB initialised');
  }

  private _initSchema(): void {
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          logger.warn({ msg }, 'SocialIntelligenceDB schema warning');
        }
      }
    }
  }

  // Contact CRUD
  insertContact(c: Contact): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO social_contacts
        (id, name, platform, platform_id, relationship, trust_score,
         interaction_count, last_interaction, notes, tags, updated_at)
      VALUES
        (:id, :name, :platform, :platform_id, :relationship, :trust_score,
         :interaction_count, :last_interaction, :notes, :tags,
         strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run({ id: c.id, name: c.name, platform: c.platform, platform_id: c.platformId ?? null,
      relationship: c.relationship, trust_score: c.trustScore, interaction_count: c.interactionCount,
      last_interaction: c.lastInteraction ?? null, notes: c.notes, tags: JSON.stringify(c.tags) });
  }

  updateContact(id: string, updates: Partial<Contact>): boolean {
    const existing = this.getContactById(id);
    if (!existing) return false;
    const merged: Contact = { ...existing, ...updates, id };
    this.insertContact(merged);
    return true;
  }

  getContactById(id: string): Contact | null {
    const row = this.db.prepare<{ id: string }, ContactRow>(
      'SELECT * FROM social_contacts WHERE id = :id'
    ).get({ id });
    return row ? rowToContact(row) : null;
  }

  searchContacts(query: string, limit = 50): Contact[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.db.prepare<{ like: string; limit: number }, ContactRow>(`
      SELECT * FROM social_contacts
      WHERE lower(name) LIKE :like
         OR lower(notes) LIKE :like
         OR lower(tags)  LIKE :like
         OR lower(platform) LIKE :like
      ORDER BY trust_score DESC, interaction_count DESC
      LIMIT :limit
    `).all({ like, limit });
    return rows.map(rowToContact);
  }

  // Interaction CRUD
  insertInteraction(i: Interaction): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO social_interactions
        (id, contact_id, type, content, sentiment, platform, timestamp)
      VALUES
        (:id, :contact_id, :type, :content, :sentiment, :platform, :timestamp)
    `).run({ id: i.id, contact_id: i.contactId, type: i.type,
      content: i.content, sentiment: i.sentiment, platform: i.platform, timestamp: i.timestamp });

    this.db.prepare(
      `UPDATE social_contacts SET interaction_count=interaction_count+1, last_interaction=:ts, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=:id`
    ).run({ id: i.contactId, ts: i.timestamp });
  }

  getInteractionsByContact(contactId: string, limit = 50): Interaction[] {
    const rows = this.db.prepare<{ contact_id: string; limit: number }, InteractionRow>(`
      SELECT * FROM social_interactions
      WHERE contact_id = :contact_id
      ORDER BY timestamp DESC
      LIMIT :limit
    `).all({ contact_id: contactId, limit });
    return rows.map(rowToInteraction);
  }

  // Analytics queries
  getTopByTrust(limit = 10): Contact[] {
    const rows = this.db.prepare<{ limit: number }, ContactRow>(`
      SELECT * FROM social_contacts
      ORDER BY trust_score DESC, interaction_count DESC
      LIMIT :limit
    `).all({ limit });
    return rows.map(rowToContact);
  }

  getTopByInteractions(limit = 10): Contact[] {
    const rows = this.db.prepare<{ limit: number }, ContactRow>(`
      SELECT * FROM social_contacts
      ORDER BY interaction_count DESC, trust_score DESC
      LIMIT :limit
    `).all({ limit });
    return rows.map(rowToContact);
  }

  getCollaborationCandidates(): Contact[] {
    const rows = this.db.prepare<Record<string, never>, ContactRow>(`
      SELECT * FROM social_contacts
      WHERE relationship IN ('collaborator', 'friend', 'mentor')
        AND trust_score >= 7.0
      ORDER BY trust_score DESC, interaction_count DESC
      LIMIT 20
    `).all({});
    return rows.map(rowToContact);
  }

  getCommunityStats(): {
    total: number;
    byPlatform: Record<string, number>;
    byRelationship: Record<string, number>;
    avgTrust: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM social_contacts').get() as { n: number }).n;
    const avgRow = this.db.prepare('SELECT AVG(trust_score) AS avg FROM social_contacts').get() as { avg: number | null };
    const avgTrust = Number((avgRow.avg ?? 0).toFixed(2));

    const byPlatformRows = this.db.prepare(
      'SELECT platform, COUNT(*) AS n FROM social_contacts GROUP BY platform'
    ).all() as Array<{ platform: string; n: number }>;

    const byRelRows = this.db.prepare(
      'SELECT relationship, COUNT(*) AS n FROM social_contacts GROUP BY relationship'
    ).all() as Array<{ relationship: string; n: number }>;

    return {
      total,
      byPlatform:     Object.fromEntries(byPlatformRows.map(r => [r.platform, r.n])),
      byRelationship: Object.fromEntries(byRelRows.map(r => [r.relationship, r.n])),
      avgTrust,
    };
  }

  getRecentInteractions(limit = 20): Interaction[] {
    const rows = this.db.prepare<{ limit: number }, InteractionRow>(`
      SELECT * FROM social_interactions
      ORDER BY timestamp DESC
      LIMIT :limit
    `).all({ limit });
    return rows.map(rowToInteraction);
  }

  getSentimentCounts(): { positive: number; neutral: number; negative: number } {
    const rows = this.db.prepare(
      'SELECT sentiment, COUNT(*) AS n FROM social_interactions GROUP BY sentiment'
    ).all() as Array<{ sentiment: string; n: number }>;
    const map: Record<string, number> = Object.fromEntries(rows.map(r => [r.sentiment, r.n]));
    return {
      positive: map['positive'] ?? 0,
      neutral:  map['neutral']  ?? 0,
      negative: map['negative'] ?? 0,
    };
  }
}
