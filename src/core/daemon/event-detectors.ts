/**
 * @file event-detectors.ts
 * @description Detection routines for the Event Daemon.
 *
 * Each detector is a pure async function that receives the shared
 * DetectionState (mutated in place) and a persist callback.
 * Kept separate from event-daemon.ts to keep each file under 300 lines.
 *
 * Detectors:
 *   detectYouTubeComments   — new comments via YouTube Data API v3
 *   detectConsciousness     — thought-rate anomaly in consciousness.db
 *   detectSystemHealth      — heap memory pressure
 *   detectQuotaWarning      — cost-tracker budget proximity
 *   detectSubMilestones     — subscriber count crossing milestone thresholds
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { DaemonEvent, EventPriority } from './event-daemon-schema.js';

const log = createLogger('daemon:detectors');

const COST_FILE = resolve('data/cost-tracker.json');

// ---------------------------------------------------------------------------
// Shared mutable state passed from EventDaemon
// ---------------------------------------------------------------------------

export interface DetectionState {
  lastCommentFetch: number;
  lastSubMilestoneFetch: number;
  lastSubCount: number;
  lastThoughtCount: number;
  knownCommentIds: Set<string>;
}

export type PersistFn = (partial: {
  type: string;
  source: string;
  data: unknown;
  priority: EventPriority;
}) => DaemonEvent;

// ---------------------------------------------------------------------------
// detectYouTubeComments
// ---------------------------------------------------------------------------

export async function detectYouTubeComments(
  state: DetectionState,
  persist: PersistFn,
): Promise<DaemonEvent[]> {
  const apiKey = process.env['YOUTUBE_API_KEY'];
  const channelId = process.env['YOUTUBE_CHANNEL_ID'];
  if (!apiKey || !channelId) return [];

  // Throttle: once per 10 minutes
  if (Date.now() - state.lastCommentFetch < 600_000) return [];
  state.lastCommentFetch = Date.now();

  try {
    const url =
      `https://www.googleapis.com/youtube/v3/commentThreads` +
      `?part=snippet&allThreadsRelatedToChannelId=${encodeURIComponent(channelId)}` +
      `&maxResults=20&key=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return [];

    type CommentItem = {
      id: string;
      snippet?: { topLevelComment?: { snippet?: { textDisplay?: string; authorDisplayName?: string } } };
    };
    const json = await resp.json() as { items?: CommentItem[] };
    const items = json.items ?? [];
    const newComments: DaemonEvent[] = [];

    for (const item of items) {
      if (state.knownCommentIds.has(item.id)) continue;
      state.knownCommentIds.add(item.id);
      const snippet = item.snippet?.topLevelComment?.snippet;
      newComments.push(persist({
        type: 'comment',
        source: 'youtube-api',
        data: { commentId: item.id, text: snippet?.textDisplay, author: snippet?.authorDisplayName },
        priority: 'low',
      }));
    }

    // Bound the known-set size
    if (state.knownCommentIds.size > 5000) {
      const arr = Array.from(state.knownCommentIds);
      state.knownCommentIds = new Set(arr.slice(-3000));
    }

    return newComments;
  } catch (err) {
    log.debug({ err: String(err) }, 'Comment detection error (non-fatal)');
    return [];
  }
}

// ---------------------------------------------------------------------------
// detectConsciousness
// ---------------------------------------------------------------------------

export function detectConsciousness(
  state: DetectionState,
  persist: PersistFn,
): DaemonEvent[] {
  try {
    const dbPath = resolve('data/consciousness.db');
    if (!existsSync(dbPath)) return [];

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM thoughts`).get();
    db.close();

    const count = row?.count ?? 0;
    const delta = count - state.lastThoughtCount;
    state.lastThoughtCount = count;

    if (count > 100 && delta === 0) {
      return [persist({
        type: 'system',
        source: 'consciousness-monitor',
        data: { thoughtCount: count, delta, message: 'Consciousness thought rate stalled' },
        priority: 'high',
      })];
    }
  } catch { /* non-fatal — consciousness module may not be running */ }
  return [];
}

// ---------------------------------------------------------------------------
// detectSystemHealth
// ---------------------------------------------------------------------------

export function detectSystemHealth(persist: PersistFn): DaemonEvent[] {
  try {
    const used = process.memoryUsage();
    const heapPct = used.heapUsed / used.heapTotal;
    if (heapPct > 0.85) {
      return [persist({
        type: 'system',
        source: 'memory-monitor',
        data: {
          heapUsedMb: Math.round(used.heapUsed / 1_048_576),
          heapPct: heapPct.toFixed(3),
        },
        priority: 'high',
      })];
    }
  } catch { /* non-fatal */ }
  return [];
}

// ---------------------------------------------------------------------------
// detectQuotaWarning
// ---------------------------------------------------------------------------

export function detectQuotaWarning(persist: PersistFn): DaemonEvent[] {
  try {
    if (!existsSync(COST_FILE)) return [];
    const raw = readFileSync(COST_FILE, 'utf8');
    const data = JSON.parse(raw) as { todayUsd?: number; dailyBudgetUsd?: number };
    const today = data.todayUsd ?? 0;
    const budget = data.dailyBudgetUsd ?? 10;
    const pct = today / budget;
    if (pct >= 0.8) {
      const priority: EventPriority = pct >= 1.0 ? 'critical' : 'high';
      return [persist({
        type: 'quota',
        source: 'cost-tracker',
        data: { todayUsd: today, budgetUsd: budget, pct: pct.toFixed(2) },
        priority,
      })];
    }
  } catch { /* non-fatal */ }
  return [];
}

// ---------------------------------------------------------------------------
// detectSubMilestones
// ---------------------------------------------------------------------------

const SUB_MILESTONES = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];

export async function detectSubMilestones(
  state: DetectionState,
  persist: PersistFn,
): Promise<DaemonEvent[]> {
  const apiKey = process.env['YOUTUBE_API_KEY'];
  const channelId = process.env['YOUTUBE_CHANNEL_ID'];
  if (!apiKey || !channelId) return [];

  // Throttle: once per hour
  if (Date.now() - state.lastSubMilestoneFetch < 3_600_000) return [];
  state.lastSubMilestoneFetch = Date.now();

  try {
    const url =
      `https://www.googleapis.com/youtube/v3/channels` +
      `?part=statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return [];

    type ChannelItem = { statistics?: { subscriberCount?: string } };
    const json = await resp.json() as { items?: ChannelItem[] };
    const subCount = parseInt(json.items?.[0]?.statistics?.subscriberCount ?? '0', 10);
    const events: DaemonEvent[] = [];

    for (const milestone of SUB_MILESTONES) {
      if (state.lastSubCount < milestone && subCount >= milestone) {
        events.push(persist({
          type: 'sub_milestone',
          source: 'youtube-api',
          data: { milestone, currentSubs: subCount },
          priority: 'high',
        }));
      }
    }

    state.lastSubCount = subCount;
    return events;
  } catch { /* non-fatal */ }
  return [];
}
