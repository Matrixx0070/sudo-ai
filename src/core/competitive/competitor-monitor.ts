/**
 * CompetitorMonitor — track rival YouTube channels for patterns and alerts.
 * Tables: competitors, competitor_alerts (SQLite WAL).
 * checkActivity() uses the brain to generate intelligence alerts.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import { type ToolBrain } from '../brain/brain-text.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('competitor-monitor');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'competitive.db');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Competitor {
  id: string;
  channelName: string;
  channelId?: string;
  channelUrl: string;
  niche: string;
  subscriberCount?: number;
  notes: string;
  addedAt: string;
}

export type AlertType = 'new_upload' | 'viral_video' | 'format_change' | 'milestone' | 'trend_shift';

export interface CompetitorAlert {
  id: string;
  competitorId: string;
  type: AlertType;
  description: string;
  detectedAt: string;
  acknowledged: boolean;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface CompetitorRow {
  id: string; channel_name: string; channel_id: string | null;
  channel_url: string; niche: string; subscriber_count: number | null;
  notes: string; added_at: string;
}

interface AlertRow {
  id: string; competitor_id: string; type: string;
  description: string; detected_at: string; acknowledged: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToCompetitor(r: CompetitorRow): Competitor {
  return {
    id: r.id, channelName: r.channel_name, channelId: r.channel_id ?? undefined,
    channelUrl: r.channel_url, niche: r.niche,
    subscriberCount: r.subscriber_count ?? undefined, notes: r.notes, addedAt: r.added_at,
  };
}

function rowToAlert(r: AlertRow): CompetitorAlert {
  return {
    id: r.id, competitorId: r.competitor_id, type: r.type as AlertType,
    description: r.description, detectedAt: r.detected_at, acknowledged: r.acknowledged === 1,
  };
}

// ---------------------------------------------------------------------------
// CompetitorMonitor
// ---------------------------------------------------------------------------

export class CompetitorMonitor {
  private readonly db: Database.Database;

  /**
   * @param brain Accepted but no longer used (GAP-15). The brain previously
   *   generated fabricated competitor alerts; that path is gone. The parameter
   *   is retained because the only caller,
   *   `src/core/tools/builtin/meta/competitor-tool.ts:99`, lives under a
   *   PROTECTED path and cannot be edited here. Drop it when that file is
   *   migrated, alongside the real RSS-based monitoring in GAP-15.
   */
  constructor(dbPath: string = DEFAULT_DB_PATH, _brain?: ToolBrain) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    log.info({ dbPath }, 'CompetitorMonitor initialised');
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS competitors (
        id TEXT PRIMARY KEY, channel_name TEXT NOT NULL, channel_id TEXT,
        channel_url TEXT NOT NULL, niche TEXT NOT NULL DEFAULT '',
        subscriber_count INTEGER, notes TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_competitors_niche ON competitors(niche);
      CREATE TABLE IF NOT EXISTS competitor_alerts (
        id TEXT PRIMARY KEY, competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
        type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        detected_at TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_competitor   ON competitor_alerts(competitor_id, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON competitor_alerts(acknowledged, detected_at DESC);
    `);
  }

  // -------------------------------------------------------------------------
  // Competitor management
  // -------------------------------------------------------------------------

  addCompetitor(name: string, url: string, niche: string, channelId?: string): string {
    if (!name?.trim()) throw new BusinessError('channelName is required', 'invalid_input');
    if (!url?.trim()) throw new BusinessError('channelUrl is required', 'invalid_input');
    if (!niche?.trim()) throw new BusinessError('niche is required', 'invalid_input');
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO competitors (id, channel_name, channel_id, channel_url, niche, notes, added_at)
      VALUES (@id, @name, @channelId, @url, @niche, '', @now)
    `).run({ id, name: name.trim(), channelId: channelId?.trim() ?? null, url: url.trim(), niche: niche.trim(), now });
    log.info({ id, name, niche }, 'Competitor added');
    return id;
  }

  removeCompetitor(id: string): void {
    if (!id?.trim()) throw new BusinessError('id is required', 'invalid_input');
    const info = this.db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
    if (info.changes === 0) throw new BusinessError(`Competitor not found: ${id}`, 'not_found', { id });
    log.info({ id }, 'Competitor removed');
  }

  listCompetitors(): Competitor[] {
    return (this.db.prepare('SELECT * FROM competitors ORDER BY added_at DESC').all() as CompetitorRow[]).map(rowToCompetitor);
  }

  getCompetitor(id: string): Competitor | null {
    if (!id?.trim()) return null;
    const row = this.db.prepare('SELECT * FROM competitors WHERE id = ?').get(id) as CompetitorRow | undefined;
    return row ? rowToCompetitor(row) : null;
  }

  // -------------------------------------------------------------------------
  // Activity checks
  // -------------------------------------------------------------------------

  async checkActivity(competitorId: string): Promise<CompetitorAlert[]> {
    const competitor = this.getCompetitor(competitorId);
    if (!competitor) throw new BusinessError(`Competitor not found: ${competitorId}`, 'not_found', { competitorId });
    log.info({ competitorId, name: competitor.channelName }, 'Checking competitor activity');

    // GAP-15. This method used to pass the competitor's stored metadata to the
    // brain with the instruction "generate 1-3 REALISTIC activity alerts", parse
    // the reply, and _insertAlert() the results — into the same table, with the
    // same shape, that a real observation would occupy. It made no network call.
    // Nothing downstream could distinguish an invented `new_upload` or
    // `milestone` from an observed one, and because the output was varied and
    // specific rather than an obvious constant, it read as intelligence.
    //
    // Inventing observations is not a degraded form of monitoring; it is worse
    // than no monitoring, because it gets believed. The honest fallback that
    // already existed below is now the only path.
    //
    // Real monitoring is cheap and is tracked as GAP-15/GAP-08: the channel RSS
    // feed (youtube.com/feeds/videos.xml?channel_id=…, 0 quota units) detects
    // new uploads, and videos.list (1 unit) gives view counts for viral
    // detection. `format_change` and `trend_shift` are dropped — they were never
    // measurable and existed only because a model could produce the words.
    const newAlerts: CompetitorAlert[] = [
      this._insertAlert(
        competitorId,
        'trend_shift',
        `Manual check recommended for ${competitor.channelName} — visit ${competitor.channelUrl}`,
      ),
    ];

    log.info({ competitorId, count: newAlerts.length }, 'Activity check complete');
    return newAlerts;
  }

  async checkAll(): Promise<CompetitorAlert[]> {
    const all: CompetitorAlert[] = [];
    for (const c of this.listCompetitors()) {
      try { all.push(...await this.checkActivity(c.id)); }
      catch (err) { log.error({ id: c.id, err: err instanceof Error ? err.message : String(err) }, 'checkAll skip'); }
    }
    log.info({ total: all.length }, 'checkAll complete');
    return all;
  }

  // -------------------------------------------------------------------------
  // Alert management
  // -------------------------------------------------------------------------

  getAlerts(limit = 50, unacknowledgedOnly = false): CompetitorAlert[] {
    const n = Math.max(1, Math.min(500, limit));
    const rows = unacknowledgedOnly
      ? this.db.prepare('SELECT * FROM competitor_alerts WHERE acknowledged = 0 ORDER BY detected_at DESC LIMIT ?').all(n)
      : this.db.prepare('SELECT * FROM competitor_alerts ORDER BY detected_at DESC LIMIT ?').all(n);
    return (rows as AlertRow[]).map(rowToAlert);
  }

  acknowledgeAlert(alertId: string): void {
    if (!alertId?.trim()) throw new BusinessError('alertId is required', 'invalid_input');
    const info = this.db.prepare('UPDATE competitor_alerts SET acknowledged = 1 WHERE id = ?').run(alertId);
    if (info.changes === 0) throw new BusinessError(`Alert not found: ${alertId}`, 'not_found', { alertId });
    log.info({ alertId }, 'Alert acknowledged');
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  compareWithSelf(
    competitorId: string,
    selfMetrics: { subscribers: number; avgViews: number; uploadFrequencyPerWeek: number },
  ): Array<{ metric: string; self: number; competitor: number; gap: string }> {
    const competitor = this.getCompetitor(competitorId);
    if (!competitor) throw new BusinessError(`Competitor not found: ${competitorId}`, 'not_found', { competitorId });

    const compSubs = competitor.subscriberCount ?? 0;
    const uploadAlerts = (this.db.prepare(
      "SELECT COUNT(*) as n FROM competitor_alerts WHERE competitor_id = ? AND type = 'new_upload'"
    ).get(competitorId) as { n: number }).n;

    const make = (metric: string, self: number, comp: number) => {
      const diff = comp - self;
      const pct = self > 0 ? `${((diff / self) * 100).toFixed(1)}%` : 'N/A';
      const dir = diff > 0 ? 'ahead by' : diff < 0 ? 'behind by' : 'tied';
      return { metric, self, competitor: comp, gap: diff === 0 ? 'Tied' : `Competitor ${dir} ${Math.abs(diff).toLocaleString()} (${pct})` };
    };

    return [
      make('Subscribers', selfMetrics.subscribers, compSubs),
      make('Detected uploads (alerts)', 0, uploadAlerts),
    ];
  }

  getStats(): { competitors: number; alerts: number; unacknowledged: number } {
    const n = (q: string) => (this.db.prepare(q).get() as { n: number }).n;
    return {
      competitors: n('SELECT COUNT(*) as n FROM competitors'),
      alerts: n('SELECT COUNT(*) as n FROM competitor_alerts'),
      unacknowledged: n('SELECT COUNT(*) as n FROM competitor_alerts WHERE acknowledged = 0'),
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _insertAlert(competitorId: string, type: AlertType, description: string): CompetitorAlert {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO competitor_alerts (id, competitor_id, type, description, detected_at, acknowledged)
      VALUES (@id, @competitorId, @type, @description, @now, 0)
    `).run({ id, competitorId, type, description: description.trim(), now });
    return { id, competitorId, type, description: description.trim(), detectedAt: now, acknowledged: false };
  }

  close(): void {
    this.db.close();
    log.info('CompetitorMonitor closed');
  }
}
