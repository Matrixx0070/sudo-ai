/**
 * SponsorManager — find, qualify, and manage brand sponsorship partnerships.
 *
 * Backed by better-sqlite3 (WAL mode). One row per sponsor in the `sponsors`
 * table. All timestamps are ISO-8601 strings.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import { NICHE_PROSPECTS, FALLBACK_PROSPECTS } from './sponsor-prospects.js';

const log = createLogger('sponsor-manager');
const DEFAULT_DB_PATH = path.resolve('data/business.db');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SponsorStatus =
  | 'prospect'
  | 'contacted'
  | 'negotiating'
  | 'active'
  | 'completed'
  | 'declined';

export interface Sponsor {
  id: string;
  brandName: string;
  contactEmail?: string;
  contactName?: string;
  niche: string;
  status: SponsorStatus;
  dealValue?: number;
  notes: string;
  createdAt: string;
  lastContactAt?: string;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface SponsorRow {
  id: string;
  brand_name: string;
  contact_email: string | null;
  contact_name: string | null;
  niche: string;
  status: string;
  deal_value: number | null;
  notes: string;
  created_at: string;
  last_contact_at: string | null;
}

const VALID_STATUSES = new Set<string>(['prospect', 'contacted', 'negotiating', 'active', 'completed', 'declined']);

function rowToSponsor(row: SponsorRow): Sponsor {
  return {
    id: row.id,
    brandName: row.brand_name,
    contactEmail: row.contact_email ?? undefined,
    contactName: row.contact_name ?? undefined,
    niche: row.niche,
    status: row.status as SponsorStatus,
    dealValue: row.deal_value ?? undefined,
    notes: row.notes,
    createdAt: row.created_at,
    lastContactAt: row.last_contact_at ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// SponsorManager
// ---------------------------------------------------------------------------

export class SponsorManager {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    log.info({ dbPath }, 'SponsorManager initialised');
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id               TEXT PRIMARY KEY,
        brand_name       TEXT NOT NULL,
        contact_email    TEXT,
        contact_name     TEXT,
        niche            TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'prospect',
        deal_value       REAL,
        notes            TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        last_contact_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sponsors_status ON sponsors(status);
      CREATE INDEX IF NOT EXISTS idx_sponsors_niche  ON sponsors(niche);
    `);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  addSponsor(input: Omit<Sponsor, 'id' | 'createdAt'>): string {
    if (!input.brandName?.trim()) throw new BusinessError('brandName is required', 'invalid_input');
    if (!VALID_STATUSES.has(input.status)) {
      throw new BusinessError(`Invalid status: ${input.status}`, 'invalid_input', { status: input.status });
    }
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sponsors
        (id, brand_name, contact_email, contact_name, niche, status, deal_value, notes, created_at, last_contact_at)
      VALUES
        (@id, @brandName, @contactEmail, @contactName, @niche, @status, @dealValue, @notes, @createdAt, @lastContactAt)
    `).run({
      id,
      brandName: input.brandName.trim(),
      contactEmail: input.contactEmail?.trim() ?? null,
      contactName: input.contactName?.trim() ?? null,
      niche: input.niche?.trim() ?? '',
      status: input.status,
      dealValue: input.dealValue ?? null,
      notes: input.notes ?? '',
      createdAt: now,
      lastContactAt: input.lastContactAt ?? null,
    });
    log.info({ id, brandName: input.brandName, status: input.status }, 'Sponsor added');
    return id;
  }

  updateStatus(id: string, status: SponsorStatus, notes?: string): void {
    if (!id?.trim()) throw new BusinessError('id is required', 'invalid_input');
    const existing = this.getSponsor(id);
    if (!existing) throw new BusinessError(`Sponsor not found: ${id}`, 'not_found', { id });
    const now = new Date().toISOString();
    const updatedNotes = notes
      ? `${existing.notes}\n[${now}] ${notes}`.trim()
      : existing.notes;
    this.db.prepare(
      'UPDATE sponsors SET status = @status, notes = @notes, last_contact_at = @now WHERE id = @id'
    ).run({ id, status, notes: updatedNotes, now });
    log.info({ id, status }, 'Sponsor status updated');
  }

  getSponsor(id: string): Sponsor | null {
    if (!id?.trim()) return null;
    const row = this.db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id) as SponsorRow | undefined;
    return row ? rowToSponsor(row) : null;
  }

  listSponsors(filter?: { status?: string }): Sponsor[] {
    if (filter?.status) {
      const rows = this.db.prepare('SELECT * FROM sponsors WHERE status = ? ORDER BY created_at DESC').all(filter.status) as SponsorRow[];
      return rows.map(rowToSponsor);
    }
    const rows = this.db.prepare('SELECT * FROM sponsors ORDER BY created_at DESC').all() as SponsorRow[];
    return rows.map(rowToSponsor);
  }

  // -------------------------------------------------------------------------
  // Intelligence helpers
  // -------------------------------------------------------------------------

  findProspects(niche: string): string[] {
    if (!niche?.trim()) throw new BusinessError('niche is required', 'invalid_input');
    const key = niche.toLowerCase().trim();
    if (NICHE_PROSPECTS[key]) return NICHE_PROSPECTS[key]!;
    for (const [cat, brands] of Object.entries(NICHE_PROSPECTS)) {
      if (cat.includes(key) || key.includes(cat)) return brands;
    }
    return FALLBACK_PROSPECTS;
  }

  getPipeline(): { prospects: number; contacted: number; negotiating: number; active: number; totalRevenue: number } {
    const counts = this.db.prepare('SELECT status, COUNT(*) as n FROM sponsors GROUP BY status').all() as Array<{ status: string; n: number }>;
    const s: Record<string, number> = {};
    for (const row of counts) s[row.status] = row.n;
    const rev = this.db.prepare(
      "SELECT COALESCE(SUM(deal_value), 0) as total FROM sponsors WHERE status IN ('active','completed') AND deal_value IS NOT NULL"
    ).get() as { total: number };
    return { prospects: s['prospect'] ?? 0, contacted: s['contacted'] ?? 0, negotiating: s['negotiating'] ?? 0, active: s['active'] ?? 0, totalRevenue: rev.total };
  }

  generateOutreachEmail(sponsor: Sponsor, channelStats: { subscribers: number; avgViews: number }): string {
    const fmt = (n: number): string =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : String(n);
    const greeting = sponsor.contactName ? `Hi ${sponsor.contactName},` : `Hi ${sponsor.brandName} Partnerships Team,`;
    return `Subject: Partnership Opportunity — SUDO-AI YouTube Channel

${greeting}

I'm reaching out to explore a potential sponsorship collaboration with ${sponsor.brandName}.

Channel stats: ${fmt(channelStats.subscribers)} subscribers | ${fmt(channelStats.avgViews)} avg views
Niche: Technology / AI / Productivity — South Asia audience (India, Pakistan)

${sponsor.brandName}'s focus on ${sponsor.niche} aligns well with our audience's interests.

What I can offer: dedicated sponsor segment (60–90s), custom CTA link, social mention, optional Shorts.

Happy to discuss rates and campaign goals on a quick call.

Best regards,
[Your Name] | [Channel URL] | [Email]

---
Notes: ${sponsor.notes || 'First outreach.'}`;
  }

  close(): void {
    this.db.close();
    log.info('SponsorManager closed');
  }
}
