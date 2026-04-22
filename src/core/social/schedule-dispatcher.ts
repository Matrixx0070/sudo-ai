/**
 * @file schedule-dispatcher.ts
 * @description Daemon that polls the scheduled_posts SQLite table every 60 seconds
 * and dispatches due posts to the appropriate platform adapters.
 */

import type { Database, Statement } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type { PostStatus, ScheduledPost } from './schedule-dispatcher-types.js';

const logger = createLogger('social:schedule-dispatcher');

// ---------------------------------------------------------------------------
// Mastodon adapter type alias — avoids static import of Builder B's file
// ---------------------------------------------------------------------------

type MastodonPostOptions = {
  status: string;
  mediaIds?: string[];
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  inReplyToId?: string;
  signal?: AbortSignal;
};

type MastodonPostResult = { id: string; url: string; createdAt: string };

type MastodonAdapter = (opts: MastodonPostOptions) => Promise<MastodonPostResult>;

// ---------------------------------------------------------------------------
// Row shape returned from SQLite (snake_case)
// ---------------------------------------------------------------------------

interface ScheduledPostRow {
  id: string;
  content: string;
  platforms: string;       // JSON-encoded string[]
  media_urls: string;      // JSON-encoded string[]
  schedule_time: string;
  created_at: string;
  status: string;
  dispatched_at: string | null;
  error_message: string | null;
  retry_count: number;
}

// ---------------------------------------------------------------------------
// Row → domain model
// ---------------------------------------------------------------------------

function safeParsePlatformsArray(raw: string, field: string, id: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    logger.warn({ id, field, err: err instanceof Error ? err.message : String(err) }, 'rowToPost: JSON.parse failed — returning []');
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn({ id, field, type: typeof parsed }, 'rowToPost: parsed value is not an array — returning []');
    return [];
  }
  return parsed as string[];
}

function rowToPost(row: ScheduledPostRow): ScheduledPost {
  return {
    id: row.id,
    content: row.content,
    platforms: safeParsePlatformsArray(row.platforms, 'platforms', row.id),
    mediaUrls: safeParsePlatformsArray(row.media_urls, 'media_urls', row.id),
    scheduleTime: row.schedule_time,
    createdAt: row.created_at,
    status: row.status as PostStatus,
    dispatchedAt: row.dispatched_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    retryCount: row.retry_count,
  };
}

// ---------------------------------------------------------------------------
// ScheduleStore — thin SQLite wrapper with prepared statements
// ---------------------------------------------------------------------------

export class ScheduleStore {
  private readonly stmtInsert: Statement;
  private readonly stmtGetDue: Statement;
  private readonly stmtMarkSent: Statement;
  private readonly stmtMarkFailed: Statement;
  private readonly stmtCancel: Statement;
  private readonly stmtList: Statement;

  constructor(private readonly db: Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO scheduled_posts
        (id, content, platforms, media_urls, schedule_time, created_at, status, retry_count)
      VALUES
        (@id, @content, @platforms, @mediaUrls, @scheduleTime, @createdAt, 'pending', 0)
    `);

    this.stmtGetDue = db.prepare(`
      SELECT * FROM scheduled_posts
      WHERE status IN ('pending', 'failed')
        AND retry_count < 3
        AND schedule_time <= @now
      ORDER BY schedule_time ASC
    `);

    this.stmtMarkSent = db.prepare(`
      UPDATE scheduled_posts
      SET status = 'sent', dispatched_at = @dispatchedAt, error_message = NULL
      WHERE id = @id
    `);

    this.stmtMarkFailed = db.prepare(`
      UPDATE scheduled_posts
      SET status = @status,
          error_message = @errorMessage,
          retry_count = retry_count + 1
      WHERE id = @id
    `);

    this.stmtCancel = db.prepare(`
      UPDATE scheduled_posts SET status = 'cancelled' WHERE id = @id
    `);

    this.stmtList = db.prepare(`
      SELECT * FROM scheduled_posts ORDER BY schedule_time ASC
    `);
  }

  insert(post: Omit<ScheduledPost, 'status' | 'retryCount' | 'dispatchedAt' | 'errorMessage'>): ScheduledPost {
    const id = post.id || genId();
    const now = new Date().toISOString();
    this.stmtInsert.run({
      id,
      content: post.content,
      platforms: JSON.stringify(post.platforms),
      mediaUrls: JSON.stringify(post.mediaUrls),
      scheduleTime: post.scheduleTime,
      createdAt: post.createdAt || now,
    });
    logger.debug({ id }, 'scheduled_post inserted');
    return { ...post, id, status: 'pending', retryCount: 0, createdAt: post.createdAt || now };
  }

  getDue(now: string): ScheduledPost[] {
    return (this.stmtGetDue.all({ now }) as ScheduledPostRow[]).map(rowToPost);
  }

  markSent(id: string): void {
    this.stmtMarkSent.run({ id, dispatchedAt: new Date().toISOString() });
    logger.debug({ id }, 'scheduled_post marked sent');
  }

  markFailed(id: string, errorMessage: string, retryCount: number): void {
    // permanent exclusion at retry_count >= 3 is enforced by getDue() WHERE clause
    const newStatus: PostStatus = 'failed';
    this.stmtMarkFailed.run({ id, status: newStatus, errorMessage });
    logger.debug({ id, retryCount, newStatus }, 'scheduled_post marked failed');
  }

  cancel(id: string): void {
    this.stmtCancel.run({ id });
    logger.debug({ id }, 'scheduled_post cancelled');
  }

  list(): ScheduledPost[] {
    return (this.stmtList.all() as ScheduledPostRow[]).map(rowToPost);
  }
}

// ---------------------------------------------------------------------------
// ScheduleDispatcher — lifecycle wrapper
// ---------------------------------------------------------------------------

export class ScheduleDispatcher {
  readonly store: ScheduleStore;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly mastodonAdapter: MastodonAdapter | undefined;

  constructor(db: Database, mastodonAdapter?: MastodonAdapter) {
    this.store = new ScheduleStore(db);
    this.mastodonAdapter = mastodonAdapter;
  }

  start(): void {
    if (this.interval !== null) {
      logger.warn('ScheduleDispatcher.start() called while already running — ignoring');
      return;
    }
    logger.info('ScheduleDispatcher starting (60s interval)');
    this.interval = setInterval(() => {
      this.tick().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg }, 'ScheduleDispatcher tick error');
      });
    }, 60_000);
  }

  stop(): void {
    if (this.interval === null) {
      logger.warn('ScheduleDispatcher.stop() called while not running — ignoring');
      return;
    }
    clearInterval(this.interval);
    this.interval = null;
    logger.info('ScheduleDispatcher stopped');
  }

  async tick(): Promise<void> {
    const now = new Date().toISOString();
    const due = this.store.getDue(now);
    if (due.length === 0) { logger.debug({ now }, 'tick: no due posts'); return; }
    logger.info({ count: due.length, now }, 'tick: dispatching due posts');

    for (const post of due) {
      try {
        const platform = post.platforms[0];
        if (!platform) {
          logger.warn({ id: post.id }, 'tick: post has no platform entry — skipping');
          continue;
        }
        // Builder B guarantees one row per platform; treat each row atomically.
        await this.dispatchPlatform(post, platform);
      } catch (err: unknown) {
        // Outer guard: ensure a single bad post never aborts the whole tick loop.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ id: post.id, err: msg }, 'tick: unexpected error processing post');
      }
    }
  }

  private async dispatchPlatform(post: ScheduledPost, platform: string): Promise<void> {
    try {
      if (platform === 'mastodon') {
        await this.dispatchMastodon(post);
      } else if (platform === 'twitter') {
        await this.dispatchTwitter(post);
      } else {
        logger.warn({ id: post.id, platform }, 'unknown platform — skipping');
        return;
      }
      this.store.markSent(post.id);
      logger.info({ id: post.id, platform }, 'post dispatched successfully');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ id: post.id, platform, retryCount: post.retryCount, err: msg }, 'dispatch failed');
      this.store.markFailed(post.id, msg, post.retryCount);
    }
  }

  private async dispatchMastodon(post: ScheduledPost): Promise<void> {
    let adapter = this.mastodonAdapter;
    if (!adapter) {
      // Dynamic import to avoid compile-time dependency on Builder B's file
      const mod = await import('../tools/builtin/social/mastodon.js') as { postToMastodon: MastodonAdapter };
      adapter = mod.postToMastodon;
    }
    await adapter({ status: post.content, signal: AbortSignal.timeout(30_000) });
  }

  private async dispatchTwitter(post: ScheduledPost): Promise<void> {
    // Delegate to the canonical twitter-manager tool to avoid duplicating
    // auth/network logic. Dynamic import mirrors mastodon dispatch pattern.
    const { twitterManagerTool } = await import('../tools/builtin/social/twitter-tools.js') as {
      twitterManagerTool: import('../tools/types.js').ToolDefinition;
    };
    const ctx: import('../tools/types.js').ToolContext = {
      sessionId: `scheduler:${post.id}`,
      workingDir: process.cwd(),
      config: {},
      logger: logger,
      signal: AbortSignal.timeout(30_000),
    };
    const result = await twitterManagerTool.execute({ action: 'tweet', text: post.content }, ctx);
    if (!result.success) {
      throw new Error(result.output);
    }
    logger.debug({ id: post.id }, 'twitter post dispatched via twitter-manager');
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton helpers
// ---------------------------------------------------------------------------

let _instance: ScheduleDispatcher | null = null;

export function setDispatcherInstance(d: ScheduleDispatcher): void {
  _instance?.stop();
  _instance = d;
}

export function getDispatcherInstance(): ScheduleDispatcher {
  if (_instance === null) throw new Error('ScheduleDispatcher has not been initialised — call setDispatcherInstance() first');
  return _instance;
}
