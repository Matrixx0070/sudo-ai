/**
 * Unit tests for schedulePostTool (social.schedule-post) and validateScheduleTime
 * exercised indirectly through the tool's execute() method.
 * Also tests multiPostTool's schedule branch.
 *
 * Uses real :memory: DB + initializeSchema + ScheduleDispatcher.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initializeSchema } from '../../../../src/core/memory/schema.js';
import {
  ScheduleDispatcher,
  setDispatcherInstance,
} from '../../../../src/core/social/schedule-dispatcher.js';
import { schedulePostTool, multiPostTool } from '../../../../src/core/tools/builtin/social/platform-tools.js';
import type { ToolContext } from '../../../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): DatabaseType {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp',
    config: {} as ToolContext['config'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ToolContext['logger'],
    ...overrides,
  };
}

function futureISO(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// validateScheduleTime — tested through schedulePostTool.execute
// ---------------------------------------------------------------------------

describe('validateScheduleTime — via schedulePostTool.create', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('rejects undefined scheduleTime', async () => {
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Hello', platforms: ['mastodon'] },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('scheduleTime');
  });

  it('rejects empty string scheduleTime', async () => {
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Hello', platforms: ['mastodon'], scheduleTime: '' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('scheduleTime');
  });

  it('rejects non-ISO scheduleTime string', async () => {
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Hello', platforms: ['mastodon'], scheduleTime: 'not-a-date' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid|not a valid/i);
  });

  it('rejects past date scheduleTime', async () => {
    const pastDate = new Date(Date.now() - 10_000).toISOString();
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Hello', platforms: ['mastodon'], scheduleTime: pastDate },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/future/i);
  });

  it('accepts future ISO scheduleTime and returns canonical UTC ISO', async () => {
    const futureTime = futureISO();
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Future post', platforms: ['mastodon'], scheduleTime: futureTime },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    // The schedule time in result should be a valid ISO UTC string
    const data = result.data as { scheduleTime?: string };
    expect(data?.scheduleTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});

// ---------------------------------------------------------------------------
// schedulePostTool.create — single platform (backward compat)
// ---------------------------------------------------------------------------

describe('schedulePostTool — create with single platform', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('single-platform string inserts 1 row and returns single entry (backward compat)', async () => {
    const futureTime = futureISO();
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Single platform post', platforms: 'mastodon', scheduleTime: futureTime },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    // Single platform returns a single entry (not a {scheduled:[...]} wrapper)
    const data = result.data as { id?: string; platforms?: string[] };
    expect(data?.id).toBeTruthy();
    expect(data?.platforms).toEqual(['mastodon']);

    // Verify DB has exactly 1 row
    const rows = db.prepare('SELECT * FROM scheduled_posts').all();
    expect(rows).toHaveLength(1);
  });

  it('single-platform array of 1 also inserts 1 row', async () => {
    const futureTime = futureISO();
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Array single', platforms: ['mastodon'], scheduleTime: futureTime },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const rows = db.prepare('SELECT * FROM scheduled_posts').all();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// schedulePostTool.create — multi-platform array (one row per platform)
// ---------------------------------------------------------------------------

describe('schedulePostTool — create with multi-platform array', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('multi-platform array inserts N rows and returns {scheduled:[...]}', async () => {
    const futureTime = futureISO();
    const result = await schedulePostTool.execute(
      { action: 'create', content: 'Multi platform post', platforms: ['mastodon', 'twitter'], scheduleTime: futureTime },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const data = result.data as { scheduled?: Array<{ id: string; platforms: string[] }> };
    expect(Array.isArray(data?.scheduled)).toBe(true);
    expect(data.scheduled).toHaveLength(2);

    // Each entry should have a single platform
    const platformsInserted = data.scheduled!.map((e) => e.platforms[0]);
    expect(platformsInserted).toContain('mastodon');
    expect(platformsInserted).toContain('twitter');

    // Verify DB: 2 rows, each with different platform
    const rows = db.prepare('SELECT platforms FROM scheduled_posts').all() as Array<{ platforms: string }>;
    expect(rows).toHaveLength(2);
    const dbPlatforms = rows.map((r) => JSON.parse(r.platforms)[0]);
    expect(dbPlatforms).toContain('mastodon');
    expect(dbPlatforms).toContain('twitter');
  });
});

// ---------------------------------------------------------------------------
// multiPostTool — schedule branch
// ---------------------------------------------------------------------------

describe('multiPostTool — schedule branch', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('schedule branch with 2 real platforms + "schedule" inserts 2 rows (one per platform, "schedule" filtered out)', async () => {
    const futureTime = futureISO();
    const result = await multiPostTool.execute(
      {
        content: 'Multi post schedule',
        platforms: ['mastodon', 'twitter', 'schedule'],
        scheduleTime: futureTime,
      },
      makeCtx(),
    );

    // The schedule key in results should have per-platform scheduleIds
    const data = result.data as Record<string, unknown>;
    expect(data['schedule']).toBeDefined();
    const scheduleData = data['schedule'] as { success: boolean; scheduled: Record<string, { scheduleId: string; scheduleTime: string }> };
    expect(scheduleData.success).toBe(true);
    expect(scheduleData.scheduled['mastodon']?.scheduleId).toBeTruthy();
    expect(scheduleData.scheduled['twitter']?.scheduleId).toBeTruthy();
    expect(scheduleData.scheduled['schedule']).toBeUndefined(); // 'schedule' filtered out

    // Verify DB: exactly 2 rows
    const rows = db.prepare('SELECT platforms FROM scheduled_posts').all() as Array<{ platforms: string }>;
    expect(rows).toHaveLength(2);
  });

  it('schedule branch with invalid scheduleTime returns error result and NO rows inserted', async () => {
    const result = await multiPostTool.execute(
      {
        content: 'Bad schedule',
        platforms: ['mastodon', 'schedule'],
        scheduleTime: 'not-a-valid-date',
      },
      makeCtx(),
    );

    const data = result.data as Record<string, unknown>;
    const scheduleData = data['schedule'] as { success: boolean; error: string };
    expect(scheduleData.success).toBe(false);
    expect(scheduleData.error).toBeTruthy();

    // NO rows should have been inserted
    const rows = db.prepare('SELECT * FROM scheduled_posts').all();
    expect(rows).toHaveLength(0);
  });

  it('schedule branch with past scheduleTime returns error result and NO rows inserted', async () => {
    const pastTime = new Date(Date.now() - 5000).toISOString();
    const result = await multiPostTool.execute(
      {
        content: 'Past schedule',
        platforms: ['mastodon', 'schedule'],
        scheduleTime: pastTime,
      },
      makeCtx(),
    );

    const data = result.data as Record<string, unknown>;
    const scheduleData = data['schedule'] as { success: boolean; error: string };
    expect(scheduleData.success).toBe(false);
    expect(scheduleData.error).toMatch(/future/i);

    const rows = db.prepare('SELECT * FROM scheduled_posts').all();
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// schedulePostTool — cancel action
// ---------------------------------------------------------------------------

describe('schedulePostTool — cancel action', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('cancel action sets status to cancelled for existing scheduleId', async () => {
    const futureTime = futureISO();
    // Create a post first
    const createResult = await schedulePostTool.execute(
      { action: 'create', content: 'To cancel', platforms: ['mastodon'], scheduleTime: futureTime },
      makeCtx(),
    );
    expect(createResult.success).toBe(true);
    const scheduleId = (createResult.data as { id: string }).id;

    // Cancel it
    const cancelResult = await schedulePostTool.execute(
      { action: 'cancel', scheduleId },
      makeCtx(),
    );
    expect(cancelResult.success).toBe(true);

    // Verify DB status
    const row = db.prepare('SELECT status FROM scheduled_posts WHERE id=?').get(scheduleId) as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('cancel action fails gracefully for unknown scheduleId', async () => {
    const result = await schedulePostTool.execute(
      { action: 'cancel', scheduleId: 'nonexistent-id' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('nonexistent-id');
  });

  it('cancel action fails gracefully when scheduleId is missing', async () => {
    const result = await schedulePostTool.execute(
      { action: 'cancel' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('scheduleId');
  });
});

// ---------------------------------------------------------------------------
// schedulePostTool — list action
// ---------------------------------------------------------------------------

describe('schedulePostTool — list action', () => {
  let db: DatabaseType;
  let dispatcher: ScheduleDispatcher;

  beforeEach(() => {
    db = createDb();
    dispatcher = new ScheduleDispatcher(db);
    setDispatcherInstance(dispatcher);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('list returns only pending posts (excludes cancelled, sent, failed)', async () => {
    const futureTime = futureISO();

    // Create 3 posts
    await schedulePostTool.execute(
      { action: 'create', content: 'Pending 1', platforms: ['mastodon'], scheduleTime: futureTime },
      makeCtx(),
    );
    const create2 = await schedulePostTool.execute(
      { action: 'create', content: 'To cancel', platforms: ['mastodon'], scheduleTime: futureTime },
      makeCtx(),
    );

    // Manually insert a sent post
    const sentId = 'manual-sent';
    db.prepare(
      `INSERT INTO scheduled_posts (id, content, platforms, media_urls, schedule_time, created_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, 'sent', 0)`,
    ).run(sentId, 'Sent post', '["mastodon"]', '[]', futureTime, new Date().toISOString());

    // Cancel the second created post
    const scheduleId2 = (create2.data as { id: string }).id;
    await schedulePostTool.execute({ action: 'cancel', scheduleId: scheduleId2 }, makeCtx());

    // List should return only the 1 pending post
    const listResult = await schedulePostTool.execute({ action: 'list' }, makeCtx());
    expect(listResult.success).toBe(true);
    const pendingPosts = listResult.data as Array<{ status: string }>;
    expect(Array.isArray(pendingPosts)).toBe(true);
    expect(pendingPosts.every((p) => p.status === 'pending')).toBe(true);
    expect(pendingPosts).toHaveLength(1);
  });

  it('list returns empty result when no pending posts', async () => {
    const listResult = await schedulePostTool.execute({ action: 'list' }, makeCtx());
    expect(listResult.success).toBe(true);
    const data = listResult.data as Array<unknown>;
    expect(data).toHaveLength(0);
  });
});
