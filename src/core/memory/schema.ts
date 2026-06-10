/**
 * @file schema.ts
 * @description Single source of truth for ALL database table definitions in SUDO-AI v3.
 * Every CREATE TABLE, virtual table, index, and trigger lives here.
 *
 * Design note: triggers contain BEGIN...END blocks which break naive semicolon splitting.
 * Statements are therefore stored as an explicit string array — one complete statement
 * per element — so initializeSchema() can call db.exec() on each without any parsing.
 *
 * Run initializeSchema(db) once on first open — it is idempotent via IF NOT EXISTS guards.
 * PRAGMAs are NOT included here; they are applied by MindDB via db.pragma() before this runs.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:schema');

// ---------------------------------------------------------------------------
// Table definitions
// Each string is one complete SQL statement (no trailing semicolon needed —
// better-sqlite3 db.exec() accepts both forms).
// ---------------------------------------------------------------------------

/**
 * Table catalogue:
 *  chunks            – content-addressed memory chunks (deduped via SHA-256 hash)
 *  chunks_fts        – FTS5 full-text search for BM25 ranking over chunk text
 *  embedding_cache   – local cache for OpenAI embedding API responses
 *  sessions          – conversation session metadata
 *  messages          – individual chat turns within a session
 *  tasks             – autonomous task queue with priority + dependency DAG
 *  pipeline_runs     – video/content pipeline execution records
 *  video_metrics     – YouTube / platform analytics snapshots
 *  api_costs         – per-call API cost tracking for budget awareness
 *  cron_runs         – scheduled job execution log
 *  content_ideas     – backlog of video / post ideas with AI scoring
 *  inspection_queue  – flagged content review queue
 *
 * skills table is NOT defined here — it is owned by the migration at
 * src/core/skills/sqlite-migrations/001-skills.sql.
 *
 * chunks_vec is created separately by initializeVecTable() only when sqlite-vec is loaded.
 */
const TABLE_STATEMENTS: readonly string[] = [

  // ==========================================================================
  // chunks
  // Core content-addressed memory store. Hash column enforces deduplication.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Raw text content. No length cap.
    text         TEXT    NOT NULL,
    -- Logical address: "memory/2026-03-26.md", "file:<project-root>/src/foo.ts", etc.
    path         TEXT    NOT NULL DEFAULT '',
    -- Origin category
    source       TEXT    NOT NULL DEFAULT 'conversation'
                   CHECK (source IN ('conversation','file','tool','learning')),
    -- Line range within source file (NULL for non-file sources)
    start_line   INTEGER,
    end_line     INTEGER,
    -- SHA-256 hex of text — primary deduplication key (UNIQUE enforced)
    hash         TEXT    NOT NULL UNIQUE,
    -- Embedding model that generated the vector (NULL = no embedding yet)
    model        TEXT,
    -- When 1, skip temporal decay for this chunk (permanent facts)
    is_evergreen INTEGER NOT NULL DEFAULT 0 CHECK (is_evergreen IN (0,1)),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // Update timestamp trigger for chunks
  `CREATE TRIGGER IF NOT EXISTS chunks_updated_at
    AFTER UPDATE ON chunks
    FOR EACH ROW
    BEGIN
      UPDATE chunks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // chunks_fts  (FTS5 — BM25 full-text search)
  // Content table mirrors chunks so deletes propagate automatically.
  // ==========================================================================
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content     = 'chunks',
    content_rowid = 'id',
    tokenize    = 'porter unicode61'
  )`,

  // FTS5 sync triggers
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_ai
    AFTER INSERT ON chunks
    BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END`,

  `CREATE TRIGGER IF NOT EXISTS chunks_fts_ad
    AFTER DELETE ON chunks
    BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
    END`,

  `CREATE TRIGGER IF NOT EXISTS chunks_fts_au
    AFTER UPDATE ON chunks
    BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END`,

  // ==========================================================================
  // embedding_cache
  // Persists OpenAI embeddings keyed by text hash so identical strings never
  // hit the API twice — even across process restarts.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS embedding_cache (
    -- SHA-256 of the source text
    hash       TEXT PRIMARY KEY,
    -- Raw IEEE-754 float32 bytes (BLOB, not JSON, for space efficiency)
    embedding  BLOB NOT NULL,
    -- Model identifier for cache invalidation on model change
    model      TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // sessions
  // One row per conversation session (terminal, Electron UI, API, etc.)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,  -- UUIDv4 assigned by caller
    title           TEXT,              -- Auto-generated or user-assigned title
    model           TEXT NOT NULL,     -- Model in use, e.g. "claude-sonnet-4-6"
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    total_cost_usd  REAL    NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TRIGGER IF NOT EXISTS sessions_updated_at
    AFTER UPDATE ON sessions
    FOR EACH ROW
    BEGIN
      UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // messages
  // Individual chat turns. Cascades delete when parent session is removed.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role          TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content       TEXT    NOT NULL,
    -- Optional structured tool call data (JSON strings)
    tool_name     TEXT,
    tool_input    TEXT,
    tool_output   TEXT,
    -- Token accounting
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // tasks
  // Autonomous task queue. depends_on stores a JSON array of upstream task IDs.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
    title       TEXT    NOT NULL,
    description TEXT,
    -- Lifecycle: queued → running → done | failed | cancelled
    status      TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed','cancelled')),
    priority    INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    -- JSON array of upstream task IDs that must complete first
    depends_on  TEXT    NOT NULL DEFAULT '[]',
    result      TEXT,   -- JSON result payload on success
    error       TEXT,   -- Error message on failure
    started_at  TEXT,
    finished_at TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TRIGGER IF NOT EXISTS tasks_updated_at
    AFTER UPDATE ON tasks
    FOR EACH ROW
    BEGIN
      UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // pipeline_runs
  // Records each content pipeline execution (video render, upload, etc.)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline    TEXT    NOT NULL,  -- e.g. "quiz", "comparison", "bar-race"
    channel     TEXT,              -- target YouTube channel slug
    status      TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed')),
    -- JSON bag of pipeline-specific parameters (title, topic, questionCount, etc.)
    params      TEXT    NOT NULL DEFAULT '{}',
    -- JSON bag of pipeline-specific results (output path, video id, etc.)
    result      TEXT,
    error       TEXT,
    started_at  TEXT,
    finished_at TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TRIGGER IF NOT EXISTS pipeline_runs_updated_at
    AFTER UPDATE ON pipeline_runs
    FOR EACH ROW
    BEGIN
      UPDATE pipeline_runs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // video_metrics
  // Periodic analytics snapshots per video from YouTube Data API.
  // Multiple rows per video_id — query with ORDER BY snapshot_at for history.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS video_metrics (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id         TEXT    NOT NULL,   -- YouTube video ID
    channel          TEXT    NOT NULL,   -- channel slug
    title            TEXT,
    views            INTEGER NOT NULL DEFAULT 0,
    likes            INTEGER NOT NULL DEFAULT 0,
    comments         INTEGER NOT NULL DEFAULT 0,
    watch_time_hours REAL    NOT NULL DEFAULT 0,
    ctr              REAL    NOT NULL DEFAULT 0,   -- click-through rate 0..1
    avg_view_pct     REAL    NOT NULL DEFAULT 0,   -- average view percentage 0..100
    revenue_usd      REAL    NOT NULL DEFAULT 0,
    snapshot_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // api_costs
  // Fine-grained per-call cost tracking for every external API.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS api_costs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT    NOT NULL,  -- "anthropic", "openai", "google", "xai"
    model         TEXT    NOT NULL,
    operation     TEXT    NOT NULL,  -- "completion", "embedding", "tts", etc.
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    session_id    TEXT    REFERENCES sessions(id) ON DELETE SET NULL,
    task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // cron_runs
  // Execution log for all scheduled cron jobs.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS cron_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name    TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK (status IN ('ok','failed','skipped')),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    result      TEXT,   -- JSON execution summary
    ran_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // content_ideas
  // Backlog of video / post concepts with AI-generated scoring.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS content_ideas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel         TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    description     TEXT,
    format          TEXT    NOT NULL DEFAULT 'video'
                      CHECK (format IN ('video','short','post','thread')),
    -- AI-estimated virality score 0..100
    virality_score  REAL    NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','produced')),
    -- JSON array of tags / keywords
    tags            TEXT    NOT NULL DEFAULT '[]',
    pipeline_run_id INTEGER REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TRIGGER IF NOT EXISTS content_ideas_updated_at
    AFTER UPDATE ON content_ideas
    FOR EACH ROW
    BEGIN
      UPDATE content_ideas SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // skills table: owned by the migration at src/core/skills/sqlite-migrations/001-skills.sql

  // ==========================================================================
  // scheduled_posts
  // Persistent queue for deferred social media posts managed by ScheduleDispatcher.
  // platforms and media_urls are stored as JSON arrays (TEXT).
  // retry_count >= 3 is treated as permanently failed by getDue().
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS scheduled_posts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    platforms TEXT NOT NULL,
    media_urls TEXT NOT NULL DEFAULT '[]',
    schedule_time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','sent','failed','cancelled')),
    dispatched_at TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
    ON scheduled_posts(status, schedule_time)`,

  // ==========================================================================
  // session_messages_fts (FTS5 — full-text search over messages)
  // Content-table mirrors messages; rowid = messages.id.
  // Note: corresponding ALTER TABLE columns are run by SqliteSessionStore
  // _runMigrations() because SQLite does not support IF NOT EXISTS for ALTER.
  // ==========================================================================
  `CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
    content,
    content       = 'messages',
    content_rowid = 'id',
    tokenize      = 'porter unicode61'
  )`,

  `CREATE TRIGGER IF NOT EXISTS smfts_ai
    AFTER INSERT ON messages
    BEGIN
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
    END`,

  `CREATE TRIGGER IF NOT EXISTS smfts_ad
    AFTER DELETE ON messages
    BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END`,

  `CREATE TRIGGER IF NOT EXISTS smfts_au
    AFTER UPDATE ON messages
    BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
    END`,

  // ==========================================================================
  // inspection_queue
  // Flagged content review queue — stores hash + excerpt only (no full payload).
  // Created by src/core/security/inspection-queue.ts factory; schema owned here.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS inspection_queue (
    id               TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source           TEXT NOT NULL,
    category         TEXT NOT NULL CHECK (category IN ('inbound','generated','memory')),
    severity         TEXT NOT NULL,
    payload_excerpt  TEXT NOT NULL,
    payload_hash     TEXT NOT NULL,
    pattern_matches  TEXT NOT NULL DEFAULT '[]',
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','reviewed','cleared','blocked')),
    reviewed_by      TEXT,
    reviewed_at      TEXT
  )`,

];

// ---------------------------------------------------------------------------
// Index definitions  (separate array so callers can diff-apply if needed)
// ---------------------------------------------------------------------------

/**
 * All indexes for the SUDO-AI schema.
 * Every foreign key column is indexed. High-frequency query columns are indexed.
 */
const INDEX_STATEMENTS: readonly string[] = [

  // chunks: path prefix scans, source filter, evergreen filter, time range
  `CREATE INDEX IF NOT EXISTS idx_chunks_path        ON chunks(path)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_source      ON chunks(source)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_is_evergreen ON chunks(is_evergreen)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_created_at  ON chunks(created_at)`,
  // hash has a UNIQUE constraint which already creates an index — no extra needed

  // sessions
  `CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)`,

  // messages: session lookup (most common query), role filter, time range
  `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_role        ON messages(role)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,

  // tasks: status queue polling, session FK, priority sort
  `CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_priority   ON tasks(priority DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`,

  // pipeline_runs: status, pipeline type, channel
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status    ON pipeline_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline  ON pipeline_runs(pipeline)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_channel   ON pipeline_runs(channel)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created_at ON pipeline_runs(created_at)`,

  // video_metrics: per-video history, per-channel rollups
  `CREATE INDEX IF NOT EXISTS idx_video_metrics_video_id   ON video_metrics(video_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_metrics_channel    ON video_metrics(channel)`,
  `CREATE INDEX IF NOT EXISTS idx_video_metrics_snapshot_at ON video_metrics(snapshot_at)`,
  // compound: accelerates SELECT MAX(id) FROM video_metrics GROUP BY video_id (tracker.ts:264)
  `CREATE INDEX IF NOT EXISTS idx_video_metrics_video_id_id ON video_metrics(video_id, id DESC)`,

  // api_costs: provider + date for budget rollups, session/task FKs
  `CREATE INDEX IF NOT EXISTS idx_api_costs_provider   ON api_costs(provider)`,
  `CREATE INDEX IF NOT EXISTS idx_api_costs_model      ON api_costs(model)`,
  `CREATE INDEX IF NOT EXISTS idx_api_costs_session_id ON api_costs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_costs_task_id    ON api_costs(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_costs_created_at ON api_costs(created_at)`,
  // compound: accelerates per-provider budget window queries in budget.ts
  `CREATE INDEX IF NOT EXISTS idx_api_costs_provider_created_at ON api_costs(provider, created_at)`,

  // cron_runs: job name + time range queries
  `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_name ON cron_runs(job_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cron_runs_status   ON cron_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_cron_runs_ran_at   ON cron_runs(ran_at)`,
  // compound: accelerates status-filtered time-range queries
  `CREATE INDEX IF NOT EXISTS idx_cron_runs_status_ran_at   ON cron_runs(status, ran_at)`,
  // compound: accelerates per-job-name history queries ordered by time
  `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_name_ran_at ON cron_runs(job_name, ran_at DESC)`,

  // content_ideas: channel + status for backlog queries, virality sort, pipeline FK
  `CREATE INDEX IF NOT EXISTS idx_content_ideas_channel         ON content_ideas(channel)`,
  `CREATE INDEX IF NOT EXISTS idx_content_ideas_status          ON content_ideas(status)`,
  `CREATE INDEX IF NOT EXISTS idx_content_ideas_virality_score  ON content_ideas(virality_score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_content_ideas_pipeline_run_id ON content_ideas(pipeline_run_id)`,

  // inspection_queue: status + time for queue polling, severity for priority filters
  `CREATE INDEX IF NOT EXISTS idx_inspection_queue_status_created ON inspection_queue(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_queue_severity        ON inspection_queue(severity)`,

];

// ---------------------------------------------------------------------------
// SCHEMA_SQL (legacy string export — kept for tooling / inspection only)
// initializeSchema() does NOT use this string for execution.
// ---------------------------------------------------------------------------

/** Joined DDL for documentation / offline inspection purposes only. */
export const SCHEMA_SQL: string = [
  ...TABLE_STATEMENTS,
  ...INDEX_STATEMENTS,
].join(';\n\n') + ';';

// ---------------------------------------------------------------------------
// initializeSchema
// ---------------------------------------------------------------------------

/**
 * Apply the full schema to an open database connection.
 *
 * Idempotent — all statements use IF NOT EXISTS so re-running on an existing
 * database is safe and a no-op for already-created objects.
 *
 * Must be called AFTER PRAGMAs are applied (MindDB constructor handles this).
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function initializeSchema(db: Database): void {
  const allStatements = [...TABLE_STATEMENTS, ...INDEX_STATEMENTS];

  for (const stmt of allStatements) {
    try {
      db.exec(stmt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // IF NOT EXISTS guards should prevent "already exists" errors, but be defensive.
      if (!msg.includes('already exists')) {
        log.warn({ stmt: stmt.slice(0, 120), err: msg }, '[schema] Non-fatal error');
      }
    }
  }
}

/**
 * Create the chunks_vec virtual table using the sqlite-vec extension.
 * Called only after confirming the extension is loaded — do not call otherwise.
 *
 * Dimension 1536 matches OpenAI text-embedding-3-small output.
 *
 * @param db - An open better-sqlite3 Database instance with sqlite-vec loaded.
 */
export function initializeVecTable(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id  INTEGER PRIMARY KEY,
      embedding FLOAT[1536]
    )
  `);
}
