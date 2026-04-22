/** CRM — contacts + interactions backed by better-sqlite3 (WAL, FTS5). */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import type { Contact, Interaction } from './types.js';

const log = createLogger('business');
const DB_PATH = path.resolve('data/business.db');

// Row shapes returned by SQLite
interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface InteractionRow {
  id: string;
  contact_id: string;
  type: string;
  summary: string;
  channel: string | null;
  created_at: string;
}

// Helpers
function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    company: row.company ?? undefined,
    tags: JSON.parse(row.tags) as string[],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInteraction(row: InteractionRow): Interaction {
  return {
    id: row.id,
    contactId: row.contact_id,
    type: row.type as Interaction['type'],
    summary: row.summary,
    channel: row.channel ?? undefined,
    createdAt: row.created_at,
  };
}

export class CRM {
  private readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    log.info({ dbPath }, 'CRM initialised');
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT,
        phone      TEXT,
        company    TEXT,
        tags       TEXT NOT NULL DEFAULT '[]',
        notes      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id         TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        summary    TEXT NOT NULL DEFAULT '',
        channel    TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_interactions_contact
        ON interactions(contact_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts
        USING fts5(id UNINDEXED, name, email, company, notes, content='contacts', content_rowid='rowid');

      CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
        INSERT INTO contacts_fts(rowid, id, name, email, company, notes)
          VALUES (new.rowid, new.id, new.name, new.email, new.company, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
        INSERT INTO contacts_fts(contacts_fts, rowid, id, name, email, company, notes)
          VALUES ('delete', old.rowid, old.id, old.name, old.email, old.company, old.notes);
        INSERT INTO contacts_fts(rowid, id, name, email, company, notes)
          VALUES (new.rowid, new.id, new.name, new.email, new.company, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
        INSERT INTO contacts_fts(contacts_fts, rowid, id, name, email, company, notes)
          VALUES ('delete', old.rowid, old.id, old.name, old.email, old.company, old.notes);
      END;
    `);
  }

  addContact(input: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>): Contact {
    if (!input.name?.trim()) {
      throw new BusinessError('Contact name is required', 'invalid_input', { input });
    }
    const now = new Date().toISOString();
    const contact: Contact = {
      id: nanoid(),
      name: input.name.trim(),
      email: input.email?.trim(),
      phone: input.phone?.trim(),
      company: input.company?.trim(),
      tags: Array.isArray(input.tags) ? input.tags : [],
      notes: input.notes ?? '',
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO contacts (id, name, email, phone, company, tags, notes, created_at, updated_at)
      VALUES (@id, @name, @email, @phone, @company, @tags, @notes, @createdAt, @updatedAt)
    `).run({ ...contact, tags: JSON.stringify(contact.tags) });

    log.info({ contactId: contact.id, name: contact.name }, 'Contact added');
    return contact;
  }

  updateContact(id: string, patch: Partial<Omit<Contact, 'id' | 'createdAt'>>): Contact {
    const existing = this.getContact(id);
    const now = new Date().toISOString();
    const updated: Contact = {
      ...existing,
      ...patch,
      id,
      updatedAt: now,
    };

    this.db.prepare(`
      UPDATE contacts
      SET name=@name, email=@email, phone=@phone, company=@company,
          tags=@tags, notes=@notes, updated_at=@updatedAt
      WHERE id=@id
    `).run({ ...updated, tags: JSON.stringify(updated.tags) });

    log.info({ contactId: id }, 'Contact updated');
    return updated;
  }

  getContact(id: string): Contact {
    if (!id?.trim()) throw new BusinessError('Contact id is required', 'invalid_input');
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
    if (!row) throw new BusinessError(`Contact not found: ${id}`, 'not_found', { id });
    return rowToContact(row);
  }

  searchContacts(query: string, limit = 20): Contact[] {
    if (!query?.trim()) return [];
    // Sanitize FTS5 special characters and operators to prevent query syntax errors
    const sanitized = query
      .trim()
      .replace(/[*"()]/g, '')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
      .trim();
    if (!sanitized) return [];
    const rows = this.db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contacts_fts fts ON c.id = fts.id
      WHERE contacts_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(sanitized, limit) as ContactRow[];
    return rows.map(rowToContact);
  }

  logInteraction(input: Omit<Interaction, 'id' | 'createdAt'>): Interaction {
    if (!input.contactId?.trim()) throw new BusinessError('contactId is required', 'invalid_input');
    if (!input.summary?.trim()) throw new BusinessError('summary is required', 'invalid_input');
    // Verify contact exists
    this.getContact(input.contactId);

    const interaction: Interaction = {
      id: nanoid(),
      contactId: input.contactId,
      type: input.type,
      summary: input.summary.trim(),
      channel: input.channel?.trim(),
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO interactions (id, contact_id, type, summary, channel, created_at)
      VALUES (@id, @contactId, @type, @summary, @channel, @createdAt)
    `).run(interaction);

    log.info({ interactionId: interaction.id, contactId: interaction.contactId }, 'Interaction logged');
    return interaction;
  }

  getHistory(contactId: string, limit = 50): Interaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM interactions WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(contactId, limit) as InteractionRow[];
    return rows.map(rowToInteraction);
  }

  /**
   * Returns contacts that have had no interaction in the last 7 days.
   * Useful for follow-up reminders.
   */
  getDueFollowUps(): Contact[] {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT c.* FROM contacts c
      WHERE NOT EXISTS (
        SELECT 1 FROM interactions i
        WHERE i.contact_id = c.id AND i.created_at >= ?
      )
      ORDER BY c.updated_at ASC
    `).all(cutoff) as ContactRow[];
    return rows.map(rowToContact);
  }

  getStats(): { totalContacts: number; totalInteractions: number; recentInteractions: number } {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM contacts').get() as { n: number }).n;
    const totalInt = (this.db.prepare('SELECT COUNT(*) as n FROM interactions').get() as { n: number }).n;
    const recent = (this.db.prepare(
      'SELECT COUNT(*) as n FROM interactions WHERE created_at >= ?'
    ).get(cutoff) as { n: number }).n;
    return { totalContacts: total, totalInteractions: totalInt, recentInteractions: recent };
  }

  close(): void {
    this.db.close();
    log.info('CRM database closed');
  }
}
