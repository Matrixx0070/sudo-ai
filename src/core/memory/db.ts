/**
 * @file db.ts
 * @description MindDB — the low-level SQLite access layer for SUDO-AI v3.
 *
 * Responsibilities:
 *  - Open better-sqlite3 in WAL mode
 *  - Run initializeSchema on first open
 *  - Attempt to load the sqlite-vec extension (graceful fallback if absent)
 *  - Expose a typed, parameterized-query-only CRUD API
 *
 * RULES:
 *  - better-sqlite3 is synchronous — no async/await in this file.
 *  - String interpolation in SQL is FORBIDDEN. Use named parameters only.
 *  - This file owns the DB connection lifecycle. Callers must call close().
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { initializeSchema, initializeVecTable } from './schema.js';
import { guardMemoryWrite, type MessageRole } from './injection-scanner.js';
import type { MemoryChunk } from './types.js';

// ---------------------------------------------------------------------------
// Public shape types for store/update operations
// (Row types mirror DB columns; optional fields have DB-level defaults)
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  title?: string;
  model: string;
  total_tokens?: number;
  total_cost_usd?: number;
}

export interface MessageRow {
  id?: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface TaskRow {
  id?: number;
  session_id?: string;
  title: string;
  description?: string;
  status?: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  priority?: number;
  depends_on?: number[];
  result?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface PipelineRunRow {
  id?: number;
  pipeline: string;
  channel?: string;
  status?: 'pending' | 'running' | 'done' | 'failed';
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface ApiCostRow {
  provider: string;
  model: string;
  operation: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd: number;
  session_id?: string;
  task_id?: number;
}

export interface CronRunRow {
  job_name: string;
  status: 'ok' | 'failed' | 'skipped';
  duration_ms?: number;
  error?: string;
  result?: Record<string, unknown>;
}

export interface VideoMetricsRow {
  video_id: string;
  channel: string;
  title?: string;
  views?: number;
  likes?: number;
  comments?: number;
  watch_time_hours?: number;
  ctr?: number;
  avg_view_pct?: number;
  revenue_usd?: number;
}

export interface ContentIdeaRow {
  id?: number;
  channel: string;
  title: string;
  description?: string;
  format?: 'video' | 'short' | 'post' | 'thread';
  virality_score?: number;
  status?: 'pending' | 'approved' | 'rejected' | 'produced';
  tags?: string[];
  pipeline_run_id?: number;
}

export interface StoreChunkOptions {
  startLine?: number;
  endLine?: number;
  model?: string;
  isEvergreen?: boolean;
  role?: MessageRole;
}

// ---------------------------------------------------------------------------
// MindDB
// ---------------------------------------------------------------------------

/**
 * Primary database access class for all SUDO-AI persistent state.
 *
 * Usage:
 * ```ts
 * const db = new MindDB('<project-root>/data/mind.db');
 * // ... use db ...
 * db.close();
 * ```
 */
export class MindDB {
  readonly db: Database.Database;
  /** True when sqlite-vec was successfully loaded — enables vector search */
  readonly vecLoaded: boolean;

  constructor(dbPath = 'data/mind.db') {
    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Apply WAL mode + other PRAGMAs before schema creation
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');

    // Build all tables (idempotent)
    initializeSchema(this.db);

    // Additive migration: add the contradiction-resolution columns to a
    // pre-existing chunks table (CREATE TABLE IF NOT EXISTS won't alter one that
    // already exists). ALTER TABLE ADD COLUMN is O(1) in SQLite. Idempotent.
    this._migrateChunkSupersession();

    // Attempt sqlite-vec extension load
    this.vecLoaded = this._tryLoadVec();
  }

  // -------------------------------------------------------------------------
  // Extension loading
  // -------------------------------------------------------------------------

  /**
   * Add `superseded_by`/`superseded_at` to a pre-existing chunks table.
   * No-op when the columns already exist (fresh DBs get them from schema.ts).
   */
  private _migrateChunkSupersession(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!existing.has('superseded_by')) this.db.exec('ALTER TABLE chunks ADD COLUMN superseded_by INTEGER');
    if (!existing.has('superseded_at')) this.db.exec('ALTER TABLE chunks ADD COLUMN superseded_at TEXT');
  }

  private _tryLoadVec(): boolean {
    try {
      const vecPath = this._findVecExtension();
      if (!vecPath) {
        console.info('[MindDB] sqlite-vec binary not found — falling back to BM25-only search');
        return false;
      }
      this.db.loadExtension(vecPath);
      initializeVecTable(this.db);
      console.info(`[MindDB] sqlite-vec loaded (${vecPath}) — vector search enabled`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.info(`[MindDB] sqlite-vec failed (${msg}) — falling back to BM25-only search`);
      return false;
    }
  }

  private _findVecExtension(): string | null {
    const cwd = process.cwd();
    const arch = process.arch === 'x64' ? 'x64' : process.arch;
    const platformPkg = `sqlite-vec-${process.platform}-${arch}`;

    // Direct hoisted path
    const direct = join(cwd, 'node_modules', platformPkg, 'vec0');
    if (existsSync(direct + '.so') || existsSync(direct + '.dylib') || existsSync(direct)) return direct;

    // pnpm .pnpm store — scan for matching directory
    const pnpmDir = join(cwd, 'node_modules', '.pnpm');
    try {
      for (const entry of readdirSync(pnpmDir)) {
        if (entry.startsWith(platformPkg)) {
          const p = join(pnpmDir, entry, 'node_modules', platformPkg, 'vec0');
          if (existsSync(p + '.so') || existsSync(p + '.dylib') || existsSync(p)) return p;
        }
      }
    } catch { /* ignore */ }

    return null;
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private _sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  /**
   * Insert a chunk, deduplicating by SHA-256 hash.
   * If an identical chunk already exists, returns the existing row unchanged.
   *
   * @returns The stored (or pre-existing) MemoryChunk row.
   */
  storeChunk(
    text: string,
    path: string,
    source: 'conversation' | 'file' | 'tool' | 'learning',
    opts: StoreChunkOptions = {},
  ): MemoryChunk {
    // Security: scan for prompt-injection before persisting.
    // In strict mode this throws; in sanitize mode returns cleaned text.
    const safeText = guardMemoryWrite(text, 'MindDB.storeChunk', opts.role);
    const hash = this._sha256(safeText);

    // Dedup check
    const existing = this.db
      .prepare<{ hash: string }, MemoryChunkRow>('SELECT * FROM chunks WHERE hash = :hash')
      .get({ hash });

    if (existing) {
      return rowToChunk(existing);
    }

    const stmt = this.db.prepare(`
      INSERT INTO chunks (text, path, source, start_line, end_line, hash, model, is_evergreen)
      VALUES (:text, :path, :source, :start_line, :end_line, :hash, :model, :is_evergreen)
    `);

    const info = stmt.run({
      text: safeText,
      path,
      source,
      start_line: opts.startLine ?? null,
      end_line:   opts.endLine   ?? null,
      hash,
      model:      opts.model       ?? null,
      is_evergreen: opts.isEvergreen ? 1 : 0,
    });

    return rowToChunk(
      this.db
        .prepare<{ id: number }, MemoryChunkRow>('SELECT * FROM chunks WHERE id = :id')
        .get({ id: info.lastInsertRowid as number })!,
    );
  }

  /**
   * Retrieve a chunk by primary key. Returns undefined if not found.
   */
  getChunk(id: number): MemoryChunk | undefined {
    const row = this.db
      .prepare<{ id: number }, MemoryChunkRow>('SELECT * FROM chunks WHERE id = :id')
      .get({ id });
    return row ? rowToChunk(row) : undefined;
  }

  /**
   * Delete a chunk by primary key. Returns true if a row was deleted.
   */
  deleteChunk(id: number): boolean {
    const info = this.db
      .prepare<{ id: number }>('DELETE FROM chunks WHERE id = :id')
      .run({ id });
    // Keep the ANN index in sync — chunks_vec is a vec0 virtual table with no
    // FK/trigger linkage to chunks, so its rows must be removed explicitly
    // (only exists when sqlite-vec is loaded). Best-effort.
    if (this.vecLoaded) {
      // vec0 binds its primary key as a BigInt (a plain number is rejected).
      try { this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(BigInt(id)); }
      catch { /* table absent or already gone — ignore */ }
    }
    return info.changes > 0;
  }

  /**
   * Retrieve a chunk by its SHA-256 hash. Used for dedup checks externally.
   */
  getChunkByHash(hash: string): MemoryChunk | undefined {
    const row = this.db
      .prepare<{ hash: string }, MemoryChunkRow>('SELECT * FROM chunks WHERE hash = :hash')
      .get({ hash });
    return row ? rowToChunk(row) : undefined;
  }

  /**
   * Mark `oldId` as superseded by `byId` (contradiction resolution). The row is
   * kept for audit, not deleted, and excluded from recall thereafter. Idempotent:
   * only flips a still-active row, so a second call (or self-supersede) is a no-op.
   *
   * @returns true when a row was newly marked, false otherwise.
   */
  markChunkSuperseded(oldId: number, byId: number): boolean {
    if (oldId === byId) return false; // a chunk never supersedes itself
    const info = this.db.prepare(`
      UPDATE chunks
      SET superseded_by = :byId,
          superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = :oldId AND superseded_by IS NULL
    `).run({ oldId, byId });
    return info.changes > 0;
  }

  /**
   * Active (non-superseded) chunks, newest first. Used by contradiction detection
   * to fetch comparison candidates. `limit` bounds the scan (default 200).
   */
  getActiveChunks(limit = 200): MemoryChunk[] {
    const rows = this.db
      .prepare<{ limit: number }, MemoryChunkRow>(
        'SELECT * FROM chunks WHERE superseded_by IS NULL ORDER BY id DESC LIMIT :limit',
      )
      .all({ limit });
    return rows.map(rowToChunk);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Upsert a session row. ID must be a UUIDv4 provided by the caller.
   */
  storeSession(session: SessionRow): void {
    this.db.prepare(`
      INSERT INTO sessions (id, title, model, total_tokens, total_cost_usd)
      VALUES (:id, :title, :model, :total_tokens, :total_cost_usd)
      ON CONFLICT(id) DO UPDATE SET
        title          = excluded.title,
        model          = excluded.model,
        total_tokens   = excluded.total_tokens,
        total_cost_usd = excluded.total_cost_usd
    `).run({
      id:             session.id,
      title:          session.title          ?? null,
      model:          session.model,
      total_tokens:   session.total_tokens   ?? 0,
      total_cost_usd: session.total_cost_usd ?? 0,
    });
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Insert a single message and return its auto-assigned ID.
   */
  storeMessage(
    sessionId: string,
    role: MessageRow['role'],
    content: string,
    opts: Partial<Omit<MessageRow, 'session_id' | 'role' | 'content'>> = {},
  ): number {
    // Security: scan for prompt-injection before persisting.
    // Pass the message role so assistant replies are not blocked by URL patterns.
    const safeContent = guardMemoryWrite(content, 'MindDB.storeMessage', role);
    const info = this.db.prepare(`
      INSERT INTO messages
        (session_id, role, content, tool_name, tool_input, tool_output,
         input_tokens, output_tokens, cost_usd)
      VALUES
        (:session_id, :role, :content, :tool_name, :tool_input, :tool_output,
         :input_tokens, :output_tokens, :cost_usd)
    `).run({
      session_id:    sessionId,
      role,
      content:       safeContent,
      tool_name:     opts.tool_name     ?? null,
      tool_input:    opts.tool_input    ?? null,
      tool_output:   opts.tool_output   ?? null,
      input_tokens:  opts.input_tokens  ?? 0,
      output_tokens: opts.output_tokens ?? 0,
      cost_usd:      opts.cost_usd      ?? 0,
    });
    return info.lastInsertRowid as number;
  }

  /**
   * Retrieve a single message by primary key.
   */
  getMessage(id: number): MessageRow | undefined {
    return this.db
      .prepare<{ id: number }, MessageRow>('SELECT * FROM messages WHERE id = :id')
      .get({ id });
  }

  /**
   * Retrieve recent messages for a session, newest-first then reversed to chronological.
   *
   * @param limit - Maximum number of messages to return (default: 100)
   */
  getSessionMessages(sessionId: string, limit = 100): MessageRow[] {
    const rows = this.db.prepare<{ session_id: string; limit: number }, MessageRow>(`
      SELECT * FROM messages
      WHERE session_id = :session_id
      ORDER BY id DESC
      LIMIT :limit
    `).all({ session_id: sessionId, limit });
    // Reverse to get chronological order
    return rows.reverse();
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  /**
   * Insert a new task and return its assigned ID.
   */
  storeTask(task: TaskRow): number {
    const info = this.db.prepare(`
      INSERT INTO tasks
        (session_id, title, description, status, priority, depends_on)
      VALUES
        (:session_id, :title, :description, :status, :priority, :depends_on)
    `).run({
      session_id:  task.session_id  ?? null,
      title:       task.title,
      description: task.description ?? null,
      status:      task.status      ?? 'queued',
      priority:    task.priority    ?? 5,
      depends_on:  JSON.stringify(task.depends_on ?? []),
    });
    return info.lastInsertRowid as number;
  }

  /**
   * Apply partial updates to an existing task.
   * Only provided keys are updated; undefined keys are left unchanged.
   */
  updateTask(id: number, updates: Partial<TaskRow>): void {
    const allowed: (keyof TaskRow)[] = [
      'status', 'priority', 'result', 'error', 'started_at', 'finished_at',
      'title', 'description',
    ];
    const pairs: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of allowed) {
      if (key in updates && updates[key] !== undefined) {
        pairs.push(`${key} = :${key}`);
        params[key] = key === 'depends_on'
          ? JSON.stringify(updates[key])
          : updates[key];
      }
    }

    if (pairs.length === 0) return;

    this.db.prepare(`UPDATE tasks SET ${pairs.join(', ')} WHERE id = :id`).run(params);
  }

  // -------------------------------------------------------------------------
  // Pipeline Runs
  // -------------------------------------------------------------------------

  /**
   * Insert a pipeline run record and return its assigned ID.
   */
  storePipelineRun(run: PipelineRunRow): number {
    const info = this.db.prepare(`
      INSERT INTO pipeline_runs (pipeline, channel, status, params)
      VALUES (:pipeline, :channel, :status, :params)
    `).run({
      pipeline: run.pipeline,
      channel:  run.channel ?? null,
      status:   run.status  ?? 'pending',
      params:   JSON.stringify(run.params ?? {}),
    });
    return info.lastInsertRowid as number;
  }

  /**
   * Apply partial updates to a pipeline run (e.g. mark done/failed with result).
   */
  updatePipelineRun(id: number, updates: Partial<PipelineRunRow>): void {
    const allowed: (keyof PipelineRunRow)[] = [
      'status', 'error', 'started_at', 'finished_at',
    ];
    const pairs: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const key of allowed) {
      if (key in updates && updates[key] !== undefined) {
        pairs.push(`${key} = :${key}`);
        params[key] = updates[key];
      }
    }

    // Handle result separately — must be JSON-encoded
    if (updates.result !== undefined) {
      pairs.push('result = :result');
      params['result'] = JSON.stringify(updates.result);
    }

    if (pairs.length === 0) return;

    this.db.prepare(`UPDATE pipeline_runs SET ${pairs.join(', ')} WHERE id = :id`).run(params);
  }

  // -------------------------------------------------------------------------
  // API Costs
  // -------------------------------------------------------------------------

  /**
   * Record a single API call cost entry.
   */
  storeApiCost(cost: ApiCostRow): number {
    const info = this.db.prepare(`
      INSERT INTO api_costs
        (provider, model, operation, input_tokens, output_tokens, cost_usd, session_id, task_id)
      VALUES
        (:provider, :model, :operation, :input_tokens, :output_tokens, :cost_usd, :session_id, :task_id)
    `).run({
      provider:      cost.provider,
      model:         cost.model,
      operation:     cost.operation,
      input_tokens:  cost.input_tokens  ?? 0,
      output_tokens: cost.output_tokens ?? 0,
      cost_usd:      cost.cost_usd,
      session_id:    cost.session_id ?? null,
      task_id:       cost.task_id    ?? null,
    });
    return info.lastInsertRowid as number;
  }

  // -------------------------------------------------------------------------
  // Cron Runs
  // -------------------------------------------------------------------------

  /**
   * Record the outcome of a scheduled cron job execution.
   */
  storeCronRun(run: CronRunRow): number {
    const info = this.db.prepare(`
      INSERT INTO cron_runs (job_name, status, duration_ms, error, result)
      VALUES (:job_name, :status, :duration_ms, :error, :result)
    `).run({
      job_name:    run.job_name,
      status:      run.status,
      duration_ms: run.duration_ms ?? 0,
      error:       run.error       ?? null,
      result:      run.result ? JSON.stringify(run.result) : null,
    });
    return info.lastInsertRowid as number;
  }

  // -------------------------------------------------------------------------
  // Video Metrics
  // -------------------------------------------------------------------------

  /**
   * Insert an analytics snapshot for a video. Multiple snapshots per video
   * are expected — query with ORDER BY snapshot_at to get history.
   */
  storeVideoMetrics(metrics: VideoMetricsRow): number {
    const info = this.db.prepare(`
      INSERT INTO video_metrics
        (video_id, channel, title, views, likes, comments,
         watch_time_hours, ctr, avg_view_pct, revenue_usd)
      VALUES
        (:video_id, :channel, :title, :views, :likes, :comments,
         :watch_time_hours, :ctr, :avg_view_pct, :revenue_usd)
    `).run({
      video_id:         metrics.video_id,
      channel:          metrics.channel,
      title:            metrics.title            ?? null,
      views:            metrics.views            ?? 0,
      likes:            metrics.likes            ?? 0,
      comments:         metrics.comments         ?? 0,
      watch_time_hours: metrics.watch_time_hours ?? 0,
      ctr:              metrics.ctr              ?? 0,
      avg_view_pct:     metrics.avg_view_pct     ?? 0,
      revenue_usd:      metrics.revenue_usd      ?? 0,
    });
    return info.lastInsertRowid as number;
  }

  // -------------------------------------------------------------------------
  // Content Ideas
  // -------------------------------------------------------------------------

  /**
   * Insert a content idea into the backlog and return its ID.
   */
  storeContentIdea(idea: ContentIdeaRow): number {
    const info = this.db.prepare(`
      INSERT INTO content_ideas
        (channel, title, description, format, virality_score, status, tags, pipeline_run_id)
      VALUES
        (:channel, :title, :description, :format, :virality_score, :status, :tags, :pipeline_run_id)
    `).run({
      channel:         idea.channel,
      title:           idea.title,
      description:     idea.description     ?? null,
      format:          idea.format          ?? 'video',
      virality_score:  idea.virality_score  ?? 0,
      status:          idea.status          ?? 'pending',
      tags:            JSON.stringify(idea.tags ?? []),
      pipeline_run_id: idea.pipeline_run_id ?? null,
    });
    return info.lastInsertRowid as number;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the database connection. Must be called when the process exits
   * to ensure WAL frames are flushed to the main DB file.
   */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Raw DB row shape returned by better-sqlite3 for the chunks table */
interface MemoryChunkRow {
  id: number;
  text: string;
  path: string;
  source: 'conversation' | 'file' | 'tool' | 'learning';
  start_line: number | null;
  end_line: number | null;
  hash: string;
  model: string | null;
  is_evergreen: number;
  superseded_by: number | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Convert a raw DB row to a typed MemoryChunk */
function rowToChunk(row: MemoryChunkRow): MemoryChunk {
  return {
    id:          row.id,
    text:        row.text,
    path:        row.path,
    source:      row.source,
    startLine:   row.start_line  ?? undefined,
    endLine:     row.end_line    ?? undefined,
    hash:        row.hash,
    model:       row.model       ?? undefined,
    isEvergreen: row.is_evergreen === 1,
    supersededBy: row.superseded_by ?? undefined,
    supersededAt: row.superseded_at ?? undefined,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}
