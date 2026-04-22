/**
 * TrendRadar — continuous monitoring of news, trends, and social signals.
 *
 * Interval-based orchestrator that:
 *   1. Calls all source scanners in parallel every 15 minutes (configurable)
 *   2. Applies niche-keyword matching to each item
 *   3. Generates TrendAlert records for niche-matching items
 *   4. Persists everything to mind.db via TrendRadarDB
 *   5. Fires the onTrendDetected callback for each new alert
 *
 * Companion modules:
 *   trend-radar-types.ts    — TrendItem / TrendAlert interfaces
 *   trend-radar-db.ts       — SQLite persistence layer
 *   trend-radar-scanners.ts — HN / Reddit / Google Trends HTTP scanners
 */

import { createLogger } from '../shared/logger.js';
import { TrendRadarDB } from './trend-radar-db.js';
import { scanHackerNews, scanReddit, scanGoogleTrends } from './trend-radar-scanners.js';
import type { TrendItem, TrendAlert } from './trend-radar-types.js';

export type { TrendItem, TrendAlert };

const logger = createLogger('trend-radar');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/** Keywords for Frank's content niches. Lower-case for comparison. */
const NICHE_KEYWORDS: readonly string[] = [
  'ai', 'artificial intelligence', 'chatgpt', 'gemini', 'grok', 'claude',
  'llm', 'openai', 'tech', 'india', 'pakistan', 'youtube', 'shorts',
  'viral', 'automation', 'coding', 'startup', 'machine learning',
  'deep learning', 'neural', 'robot',
];

// ---------------------------------------------------------------------------
// TrendRadar
// ---------------------------------------------------------------------------

export class TrendRadar {
  private readonly storage: TrendRadarDB;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Optional callback fired for every alert generated after a scan. */
  onTrendDetected?: (alert: TrendAlert) => void;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('TrendRadar: dbPath must be a non-empty string');
    }
    this.storage = new TrendRadarDB(dbPath);
    logger.info({ dbPath }, 'TrendRadar initialised');
  }

  // -------------------------------------------------------------------------
  // Interval control
  // -------------------------------------------------------------------------

  /** Start the background scan interval. Fires an immediate scan on start. */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.intervalHandle !== null) {
      logger.warn('TrendRadar already running — start() ignored');
      return;
    }
    logger.info({ intervalMs }, 'TrendRadar background monitor started');
    void this._runScan();
    this.intervalHandle = setInterval(() => void this._runScan(), intervalMs);
  }

  /** Stop the background scan interval. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('TrendRadar stopped');
    }
  }

  // -------------------------------------------------------------------------
  // Scan orchestration
  // -------------------------------------------------------------------------

  private async _runScan(): Promise<void> {
    try {
      const trends = await this.scanAll();
      const alerts = this.generateAlerts(trends);
      for (const alert of alerts) {
        try { this.onTrendDetected?.(alert); }
        catch (cbErr) {
          logger.error({ err: String(cbErr) }, 'onTrendDetected callback error');
        }
      }
      logger.info({ trends: trends.length, alerts: alerts.length }, 'Scan cycle complete');
    } catch (err) {
      logger.error({ err: String(err) }, 'TrendRadar scan cycle error');
    }
  }

  /** Run all scanners in parallel, apply niche matching, persist, and return. */
  async scanAll(): Promise<TrendItem[]> {
    const [hn, reddit, google] = await Promise.allSettled([
      this.scanHackerNews(),
      this.scanReddit(),
      this.scanGoogleTrends(),
    ]);

    const items: TrendItem[] = [];
    for (const result of [hn, reddit, google]) {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        logger.warn({ reason: String(result.reason) }, 'Source scan failed — skipping');
      }
    }

    this.storeTrends(items);
    return items;
  }

  /** Scan Hacker News, apply niche matching, return items. */
  async scanHackerNews(): Promise<TrendItem[]> {
    const items = await scanHackerNews();
    for (const item of items) item.matchesNiche = this.matchesNiche(item);
    return items;
  }

  /** Scan configured Reddit subreddits, apply niche matching, return items. */
  async scanReddit(subreddits?: string[]): Promise<TrendItem[]> {
    const items = await scanReddit(subreddits);
    for (const item of items) item.matchesNiche = this.matchesNiche(item);
    return items;
  }

  /** Scan Google Trends RSS, apply niche matching, return items. */
  async scanGoogleTrends(): Promise<TrendItem[]> {
    const items = await scanGoogleTrends();
    for (const item of items) item.matchesNiche = this.matchesNiche(item);
    return items;
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /** Returns true if the trend's title or category contains a niche keyword. */
  matchesNiche(item: TrendItem): boolean {
    const haystack = `${item.title} ${item.category ?? ''}`.toLowerCase();
    return NICHE_KEYWORDS.some(kw => haystack.includes(kw));
  }

  /** Generate TrendAlert records for niche-matching items and persist them. */
  generateAlerts(trends: TrendItem[]): TrendAlert[] {
    const alerts: TrendAlert[] = [];
    for (const trend of trends) {
      if (!trend.matchesNiche) continue;
      const urgency = this._urgencyFromScore(trend);
      const reason  = this._buildReason(trend);
      const action  = this._buildAction(trend);
      const id = this.storage.storeAlert(trend.id, reason, action, urgency);
      alerts.push({ id, trend, reason, suggestedAction: action, urgency });
    }
    return alerts;
  }

  private _urgencyFromScore(trend: TrendItem): TrendAlert['urgency'] {
    if (trend.source === 'google_trends' && trend.score >= 500_000) return 'critical';
    if (trend.score >= 10_000) return 'high';
    if (trend.score >= 1_000) return 'medium';
    return 'low';
  }

  private _buildReason(trend: TrendItem): string {
    const src = trend.source === 'hackernews' ? 'Hacker News'
      : trend.source === 'reddit' ? `Reddit r/${trend.category ?? 'unknown'}`
      : 'Google Trends';
    return `Trending on ${src} with ${trend.score.toLocaleString()} engagement. Matches content niches.`;
  }

  private _buildAction(trend: TrendItem): string {
    if (trend.source === 'google_trends') {
      return `Create a YouTube Short or quick explainer on "${trend.title}" while it is trending.`;
    }
    if (trend.source === 'hackernews') {
      return `Write a tech breakdown or opinion piece on "${trend.title}".`;
    }
    return `Research "${trend.title}" for potential video content. Score: ${trend.score}.`;
  }

  // -------------------------------------------------------------------------
  // Storage delegation
  // -------------------------------------------------------------------------

  storeTrends(trends: TrendItem[]): void {
    this.storage.storeTrends(trends);
  }

  getRecentTrends(hours = 24, limit = 100): TrendItem[] {
    return this.storage.getRecentTrends(hours, limit);
  }

  getAlerts(limit = 50): TrendAlert[] {
    return this.storage.getAlerts(limit);
  }

  getStats(): Record<string, unknown> {
    return {
      ...this.storage.getStats(),
      running: this.intervalHandle !== null,
    };
  }
}
