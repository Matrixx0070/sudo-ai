/**
 * @file learning/file-history.ts
 * @description Session Attribution & File History — tracks per-file change history
 * with diffs, attributes changes to specific sessions, and creates context snapshots.
 *
 * Competitive context: Claude Code has 180KB session storage with per-file attribution,
 * file history snapshots, and context collapse snapshots. This module provides
 * SUDO-AI's equivalent with SQLite-backed persistence, diff tracking, and
 * session attribution.
 *
 * @module file-history
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type {
  FileChangeRecord,
  FileChangeType,
  FileHistoryConfig,
  FileHistoryQuery,
  FileHistoryResult,
  FileHistoryStats,
  FileAttributionSummary,
  SessionAttribution,
  ContextSnapshot,
  SnapshotReason,
  FileSnapshot,
  SnapshotSignals,
  FileHistoryEvent,
} from './file-history-types.js';
import { DEFAULT_FILE_HISTORY_CONFIG } from './file-history-types.js';

const log = createLogger('learning:file-history');

// ---------------------------------------------------------------------------
// SQL row shapes — assertions at the better-sqlite3 boundary name these
// contracts; the column types are pinned by createTables() below.
// ---------------------------------------------------------------------------

interface FileChangeRow {
  id: string;
  session_id: string;
  channel: string;
  file_path: string;
  change_type: string;
  timestamp: string;
  hash_before: string;
  hash_after: string;
  lines_added: number;
  lines_deleted: number;
  diff: string;
  tool_name: string;
  description: string;
  auto_approved: number;
  total_lines: number;
}

interface SessionAttributionRow {
  session_id: string;
  channel: string;
  peer_id: string;
  model: string;
  change_count: number;
  files_changed: string;
  total_lines_added: number;
  total_lines_deleted: number;
  start_time: string;
  end_time: string;
  goal_type: string;
  completion_verdict: string;
}

interface ContextSnapshotRow {
  id: string;
  session_id: string;
  timestamp: string;
  reason: string;
  total_size_bytes: number;
  signals: string | null;
}

interface SnapshotFileRow {
  file_path: string;
  hash: string;
  size_bytes: number;
  line_count: number;
  content: string;
  truncated: number;
  last_modified: string;
}

interface CountRow {
  total: number;
}

// ---------------------------------------------------------------------------
// Diff Computation
// ---------------------------------------------------------------------------

/**
 * Compute a simple unified diff between two strings.
 * Lightweight implementation that doesn't require external dependencies.
 */
function computeUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  if (!oldContent && !newContent) return '';

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  // Simple line-by-line diff using LCS-like approach
  const maxLines = Math.max(oldLines.length, newLines.length);
  let addedCount = 0;
  let deletedCount = 0;

  // Find common prefix
  let commonPrefix = 0;
  while (
    commonPrefix < oldLines.length &&
    commonPrefix < newLines.length &&
    oldLines[commonPrefix] === newLines[commonPrefix]
  ) {
    commonPrefix++;
  }

  // Find common suffix
  let commonSuffix = 0;
  while (
    commonSuffix < oldLines.length - commonPrefix &&
    commonSuffix < newLines.length - commonPrefix &&
    oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }

  const contextLines = 3;

  // Context before changes
  const contextStart = Math.max(0, commonPrefix - contextLines);
  const oldChangeStart = commonPrefix;
  const oldChangeEnd = oldLines.length - commonSuffix;
  const newChangeStart = commonPrefix;
  const newChangeEnd = newLines.length - commonSuffix;

  const hunkStart = contextStart + 1; // 1-based
  const hunkOldCount = Math.min(oldChangeEnd, oldLines.length) - contextStart;
  const hunkNewCount = Math.min(newChangeEnd, newLines.length) - contextStart;

  lines.push(`@@ -${hunkStart},${hunkOldCount} +${hunkStart},${hunkNewCount} @@`);

  // Context lines before
  for (let i = contextStart; i < commonPrefix; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  // Deleted lines
  for (let i = oldChangeStart; i < oldChangeEnd; i++) {
    lines.push(`-${oldLines[i]}`);
    deletedCount++;
  }

  // Added lines
  for (let i = newChangeStart; i < newChangeEnd; i++) {
    lines.push(`+${newLines[i]}`);
    addedCount++;
  }

  // Context lines after
  const suffixStart = oldLines.length - commonSuffix;
  for (let i = suffixStart; i < oldLines.length; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

/**
 * Count lines added and removed from a diff.
 */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/**
 * Compute SHA-256 hash of content.
 */
function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Generate a nanoid-compatible ID.
 */
function genId(): string {
  return crypto.randomBytes(16).toString('hex').substring(0, 21);
}

/**
 * Map a file_changes row to its public record shape.
 */
function rowToChangeRecord(row: FileChangeRow): FileChangeRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    channel: row.channel,
    filePath: row.file_path,
    changeType: row.change_type as FileChangeType,
    timestamp: row.timestamp,
    hashBefore: row.hash_before,
    hashAfter: row.hash_after,
    linesAdded: row.lines_added,
    linesDeleted: row.lines_deleted,
    diff: row.diff,
    toolName: row.tool_name,
    description: row.description,
    autoApproved: row.auto_approved === 1,
    totalLines: row.total_lines,
  };
}

// ---------------------------------------------------------------------------
// File History Store (SQLite-backed)
// ---------------------------------------------------------------------------

/**
 * Session Attribution & File History store.
 *
 * Tracks per-file change history with diffs, attributes changes to specific
 * sessions, and creates context snapshots for session continuity.
 * Backed by SQLite for efficient querying and persistence.
 */
export class FileHistoryStore {
  private config: FileHistoryConfig;
  private db: Database | null = null; // dynamically imported in init()
  private initialized = false;
  private changeCounters = new Map<string, number>(); // sessionId -> change count since last snapshot
  private eventHandlers = new Map<string, Set<(event: FileHistoryEvent) => void>>();

  constructor(config?: Partial<FileHistoryConfig>) {
    this.config = { ...DEFAULT_FILE_HISTORY_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the SQLite database and create tables.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const BetterSqlite3 = await import('better-sqlite3');
      const dbPath = path.resolve(this.config.dbPath);

      // Ensure directory exists
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      const db = new BetterSqlite3.default(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');

      this.createTables(db);
      this.db = db;
      this.initialized = true;

      log.info({ dbPath }, 'File history store initialized');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to initialize file history store');
      throw err;
    }
  }

  /**
   * Create database tables if they don't exist.
   */
  private createTables(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        hash_before TEXT NOT NULL DEFAULT '',
        hash_after TEXT NOT NULL DEFAULT '',
        lines_added INTEGER NOT NULL DEFAULT 0,
        lines_deleted INTEGER NOT NULL DEFAULT 0,
        diff TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        auto_approved INTEGER NOT NULL DEFAULT 0,
        total_lines INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);
      CREATE INDEX IF NOT EXISTS idx_file_changes_timestamp ON file_changes(timestamp);
      CREATE INDEX IF NOT EXISTS idx_file_changes_type ON file_changes(change_type);
      CREATE INDEX IF NOT EXISTS idx_file_changes_session_path ON file_changes(session_id, file_path);

      CREATE TABLE IF NOT EXISTS session_attributions (
        session_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL DEFAULT '',
        peer_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        change_count INTEGER NOT NULL DEFAULT 0,
        files_changed TEXT NOT NULL DEFAULT '[]',
        total_lines_added INTEGER NOT NULL DEFAULT 0,
        total_lines_deleted INTEGER NOT NULL DEFAULT 0,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        goal_type TEXT NOT NULL DEFAULT '',
        completion_verdict TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reason TEXT NOT NULL,
        total_size_bytes INTEGER NOT NULL DEFAULT 0,
        signals TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON context_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON context_snapshots(timestamp);

      CREATE TABLE IF NOT EXISTS snapshot_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0,
        last_modified TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_files_snapshot ON snapshot_files(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_snapshot_files_path ON snapshot_files(file_path);
    `);
  }

  // -------------------------------------------------------------------------
  // Change Recording
  // -------------------------------------------------------------------------

  /**
   * Record a file change with automatic diff computation.
   *
   * @param params Change parameters.
   * @returns The created FileChangeRecord.
   */
  recordChange(params: {
    sessionId: string;
    channel?: string;
    filePath: string;
    changeType: FileChangeType;
    contentBefore?: string;
    contentAfter?: string;
    toolName?: string;
    description?: string;
    autoApproved?: boolean;
  }): FileChangeRecord {
    const db = this.requireDb();

    const {
      sessionId,
      channel = '',
      filePath,
      changeType,
      contentBefore = '',
      contentAfter = '',
      toolName = '',
      description = '',
      autoApproved = true,
    } = params;

    const hashBefore = contentBefore ? contentHash(contentBefore) : '';
    const hashAfter = contentAfter ? contentHash(contentAfter) : '';

    // Compute diff
    let diff = '';
    let linesAdded = 0;
    let linesDeleted = 0;

    if (this.config.trackDiffs && contentBefore !== contentAfter) {
      diff = computeUnifiedDiff(contentBefore, contentAfter, filePath);

      // Truncate diff if too large
      if (diff.length > this.config.maxDiffSizeBytes) {
        diff = diff.substring(0, this.config.maxDiffSizeBytes) + '\n... (truncated)';
      }

      const counts = countDiffLines(diff);
      linesAdded = counts.added;
      linesDeleted = counts.removed;
    } else if (changeType === 'create') {
      linesAdded = contentAfter ? contentAfter.split('\n').length : 0;
    } else if (changeType === 'delete') {
      linesDeleted = contentBefore ? contentBefore.split('\n').length : 0;
    }

    const totalLines = contentAfter ? contentAfter.split('\n').length : 0;
    const id = genId();
    const timestamp = new Date().toISOString();

    const record: FileChangeRecord = {
      id,
      sessionId,
      channel,
      filePath,
      changeType,
      timestamp,
      hashBefore,
      hashAfter,
      linesAdded,
      linesDeleted,
      diff,
      toolName,
      description,
      autoApproved,
      totalLines,
    };

    // Insert into database
    const insert = db.prepare(`
      INSERT INTO file_changes (
        id, session_id, channel, file_path, change_type, timestamp,
        hash_before, hash_after, lines_added, lines_deleted, diff,
        tool_name, description, auto_approved, total_lines
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    insert.run(
      record.id,
      record.sessionId,
      record.channel,
      record.filePath,
      record.changeType,
      record.timestamp,
      record.hashBefore,
      record.hashAfter,
      record.linesAdded,
      record.linesDeleted,
      record.diff,
      record.toolName,
      record.description,
      record.autoApproved ? 1 : 0,
      record.totalLines,
    );

    // Update session attribution
    this.updateAttribution(record);

    // Check if we need an auto-snapshot
    const sessionChanges = (this.changeCounters.get(sessionId) ?? 0) + 1;
    this.changeCounters.set(sessionId, sessionChanges);

    if (this.config.autoSnapshot && sessionChanges % this.config.snapshotInterval === 0) {
      this.createSnapshot(sessionId, 'milestone').catch((err) => {
        log.debug({ err: String(err) }, 'Auto-snapshot failed (non-fatal)');
      });
    }

    // Emit event
    this.emit({ type: 'change_recorded', record });

    log.debug(
      { id, sessionId, filePath, changeType, linesAdded, linesDeleted },
      'File change recorded',
    );

    return record;
  }

  // -------------------------------------------------------------------------
  // Session Attribution
  // -------------------------------------------------------------------------

  /**
   * Update session attribution after a file change.
   */
  private updateAttribution(record: FileChangeRecord): void {
    const db = this.requireDb();

    const existing = db.prepare(
      'SELECT * FROM session_attributions WHERE session_id = ?',
    ).get(record.sessionId) as SessionAttributionRow | undefined;

    if (existing) {
      // Update existing attribution
      const filesChanged = JSON.parse(existing.files_changed || '[]') as string[];
      if (!filesChanged.includes(record.filePath)) {
        filesChanged.push(record.filePath);
      }

      db.prepare(`
        UPDATE session_attributions SET
          change_count = change_count + 1,
          files_changed = ?,
          total_lines_added = total_lines_added + ?,
          total_lines_deleted = total_lines_deleted + ?,
          end_time = ?
        WHERE session_id = ?
      `).run(
        JSON.stringify(filesChanged),
        record.linesAdded,
        record.linesDeleted,
        record.timestamp,
        record.sessionId,
      );
    } else {
      // Create new attribution
      db.prepare(`
        INSERT INTO session_attributions (
          session_id, channel, peer_id, model, change_count, files_changed,
          total_lines_added, total_lines_deleted, start_time, end_time,
          goal_type, completion_verdict
        ) VALUES (?, ?, '', '', 1, ?, ?, ?, ?, ?, '', '')
      `).run(
        record.sessionId,
        record.channel,
        JSON.stringify([record.filePath]),
        record.linesAdded,
        record.linesDeleted,
        record.timestamp,
        record.timestamp,
      );
    }

    this.emit({
      type: 'attribution_updated',
      attribution: this.getAttribution(record.sessionId)!,
    });
  }

  /**
   * Get attribution for a specific session.
   */
  getAttribution(sessionId: string): SessionAttribution | null {
    const db = this.requireDb();

    const row = db.prepare(
      'SELECT * FROM session_attributions WHERE session_id = ?',
    ).get(sessionId) as SessionAttributionRow | undefined;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      channel: row.channel,
      peerId: row.peer_id,
      model: row.model,
      changeCount: row.change_count,
      filesChanged: JSON.parse(row.files_changed || '[]') as string[],
      totalLinesAdded: row.total_lines_added,
      totalLinesDeleted: row.total_lines_deleted,
      startTime: row.start_time,
      endTime: row.end_time,
      goalType: row.goal_type,
      completionVerdict: row.completion_verdict,
    };
  }

  /**
   * Get attribution summary for a specific file.
   */
  getFileAttribution(filePath: string): FileAttributionSummary {
    const db = this.requireDb();

    const rows = db.prepare(`
      SELECT session_id, channel, timestamp
      FROM file_changes
      WHERE file_path = ?
      ORDER BY timestamp DESC
    `).all(filePath) as Array<Pick<FileChangeRow, 'session_id' | 'channel' | 'timestamp'>>;

    const sessionMap = new Map<string, { sessionId: string; channel: string; changeCount: number; lastChangeTime: string }>();

    for (const row of rows) {
      const existing = sessionMap.get(row.session_id);
      if (existing) {
        existing.changeCount++;
        if (row.timestamp > existing.lastChangeTime) {
          existing.lastChangeTime = row.timestamp;
        }
      } else {
        sessionMap.set(row.session_id, {
          sessionId: row.session_id,
          channel: row.channel,
          changeCount: 1,
          lastChangeTime: row.timestamp,
        });
      }
    }

    const sessions = Array.from(sessionMap.values()).sort(
      (a, b) => b.lastChangeTime.localeCompare(a.lastChangeTime),
    );

    return {
      filePath,
      sessionCount: sessions.length,
      totalChanges: rows.length,
      sessions,
    };
  }

  // -------------------------------------------------------------------------
  // History Queries
  // -------------------------------------------------------------------------

  /**
   * Query file change history with filtering.
   */
  queryHistory(query: FileHistoryQuery): FileHistoryResult {
    const db = this.requireDb();

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (query.filePathPattern) {
      // Convert glob pattern to SQL LIKE
      const sqlPattern = query.filePathPattern
        .replace(/\*/g, '%')
        .replace(/\?/g, '_');
      conditions.push('file_path LIKE ?');
      params.push(sqlPattern);
    }

    if (query.sessionId) {
      conditions.push('session_id = ?');
      params.push(query.sessionId);
    }

    if (query.changeType) {
      conditions.push('change_type = ?');
      params.push(query.changeType);
    }

    if (query.toolName) {
      conditions.push('tool_name = ?');
      params.push(query.toolName);
    }

    if (query.startTime) {
      conditions.push('timestamp >= ?');
      params.push(query.startTime);
    }

    if (query.endTime) {
      conditions.push('timestamp <= ?');
      params.push(query.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    // Get total count
    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM file_changes ${whereClause}`,
    ).get(...params) as CountRow | undefined;

    const totalCount = countRow?.total ?? 0;

    // Get records
    const rows = db.prepare(
      `SELECT * FROM file_changes ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as FileChangeRow[];

    const records: FileChangeRecord[] = rows.map(rowToChangeRecord);

    return {
      records,
      totalCount,
      hasMore: offset + limit < totalCount,
    };
  }

  /**
   * Get file change history for a specific file.
   */
  getFileHistory(
    filePath: string,
    limit = 50,
    offset = 0,
  ): FileHistoryResult {
    return this.queryHistory({ filePathPattern: filePath, limit, offset });
  }

  /**
   * Get the most recent change for a file.
   */
  getLatestChange(filePath: string): FileChangeRecord | null {
    const db = this.requireDb();

    const row = db.prepare(
      'SELECT * FROM file_changes WHERE file_path = ? ORDER BY timestamp DESC LIMIT 1',
    ).get(filePath) as FileChangeRow | undefined;

    if (!row) return null;
    return rowToChangeRecord(row);
  }

  /**
   * Get statistics about file changes.
   */
  getStats(): FileHistoryStats {
    const db = this.requireDb();

    const totalRow = db.prepare('SELECT COUNT(*) as total FROM file_changes').get() as CountRow | undefined;
    const totalChanges = totalRow?.total ?? 0;

    const uniqueFilesRow = db.prepare('SELECT COUNT(DISTINCT file_path) as total FROM file_changes').get() as CountRow | undefined;
    const uniqueFiles = uniqueFilesRow?.total ?? 0;

    const uniqueSessionsRow = db.prepare('SELECT COUNT(DISTINCT session_id) as total FROM file_changes').get() as CountRow | undefined;
    const uniqueSessions = uniqueSessionsRow?.total ?? 0;

    // Changes by type
    const typeRows = db.prepare(
      'SELECT change_type, COUNT(*) as count FROM file_changes GROUP BY change_type',
    ).all() as Array<{ change_type: string; count: number }>;
    const changesByType: Record<string, number> = {};
    for (const row of typeRows) {
      changesByType[row.change_type] = row.count;
    }

    // Changes by tool
    const toolRows = db.prepare(
      'SELECT tool_name, COUNT(*) as count FROM file_changes GROUP BY tool_name ORDER BY count DESC LIMIT 10',
    ).all() as Array<{ tool_name: string; count: number }>;
    const changesByTool: Record<string, number> = {};
    for (const row of toolRows) {
      if (row.tool_name) changesByTool[row.tool_name] = row.count;
    }

    // Changes by day
    const dayRows = db.prepare(
      "SELECT substr(timestamp, 1, 10) as day, COUNT(*) as count FROM file_changes GROUP BY day ORDER BY day DESC LIMIT 30",
    ).all() as Array<{ day: string; count: number }>;
    const changesByDay: Record<string, number> = {};
    for (const row of dayRows) {
      changesByDay[row.day] = row.count;
    }

    // Most changed files
    const fileRows = db.prepare(
      'SELECT file_path, COUNT(*) as count FROM file_changes GROUP BY file_path ORDER BY count DESC LIMIT 10',
    ).all() as Array<{ file_path: string; count: number }>;
    const mostChangedFiles = fileRows.map((row) => ({
      filePath: row.file_path,
      changeCount: row.count,
    }));

    // Most active sessions
    const sessionRows = db.prepare(
      'SELECT session_id, COUNT(*) as count FROM file_changes GROUP BY session_id ORDER BY count DESC LIMIT 10',
    ).all() as Array<{ session_id: string; count: number }>;
    const mostActiveSessions = sessionRows.map((row) => ({
      sessionId: row.session_id,
      changeCount: row.count,
    }));

    return {
      totalChanges,
      uniqueFiles,
      uniqueSessions,
      changesByType: changesByType as Record<FileChangeType, number>,
      changesByTool,
      changesByDay,
      mostChangedFiles,
      mostActiveSessions,
    };
  }

  // -------------------------------------------------------------------------
  // Context Snapshots
  // -------------------------------------------------------------------------

  /**
   * Create a context snapshot of the current file states.
   */
  async createSnapshot(
    sessionId: string,
    reason: SnapshotReason,
    files?: Array<{ filePath: string; content: string }>,
  ): Promise<ContextSnapshot> {
    const db = this.requireDb();

    const id = genId();
    const timestamp = new Date().toISOString();
    const snapshots: FileSnapshot[] = [];
    let totalSizeBytes = 0;

    // If files are provided, snapshot them; otherwise create an empty snapshot
    const fileList = files ?? [];

    for (const file of fileList) {
      const maxSize = this.config.maxSnapshotFileSizeBytes;
      const content = file.content.length > maxSize
        ? file.content.substring(0, maxSize)
        : file.content;
      const truncated = file.content.length > maxSize;

      const snapshot: FileSnapshot = {
        filePath: file.filePath,
        hash: contentHash(file.content),
        sizeBytes: file.content.length,
        lineCount: file.content.split('\n').length,
        content,
        truncated,
        lastModified: timestamp,
      };

      snapshots.push(snapshot);
      totalSizeBytes += file.content.length;
    }

    const snapshot: ContextSnapshot = {
      id,
      sessionId,
      timestamp,
      reason,
      files: snapshots,
      totalSizeBytes,
    };

    // Insert snapshot
    db.prepare(`
      INSERT INTO context_snapshots (id, session_id, timestamp, reason, total_size_bytes, signals)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.sessionId,
      snapshot.timestamp,
      snapshot.reason,
      snapshot.totalSizeBytes,
      snapshot.signals ? JSON.stringify(snapshot.signals) : null,
    );

    // Insert snapshot files
    const insertFile = db.prepare(`
      INSERT INTO snapshot_files (snapshot_id, file_path, hash, size_bytes, line_count, content, truncated, last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of snapshots) {
      insertFile.run(
        snapshot.id,
        file.filePath,
        file.hash,
        file.sizeBytes,
        file.lineCount,
        file.content,
        file.truncated ? 1 : 0,
        file.lastModified,
      );
    }

    // Prune old snapshots for this session if exceeding limit
    this.pruneSessionSnapshots(sessionId);

    this.emit({ type: 'snapshot_created', snapshot });

    log.info(
      { id, sessionId, reason, fileCount: snapshots.length },
      'Context snapshot created',
    );

    return snapshot;
  }

  /**
   * Create a session start snapshot.
   * Captures the current state of all project files.
   */
  async createSessionStartSnapshot(
    sessionId: string,
    workspaceFiles: Array<{ filePath: string; content: string }>,
    signals?: SnapshotSignals,
  ): Promise<ContextSnapshot> {
    const snapshot = await this.createSnapshot(sessionId, 'session_start', workspaceFiles);

    if (signals) {
      // Update snapshot with signals
      this.requireDb().prepare(
        'UPDATE context_snapshots SET signals = ? WHERE id = ?',
      ).run(JSON.stringify(signals), snapshot.id);
    }

    return snapshot;
  }

  /**
   * Create a session end snapshot.
   */
  async createSessionEndSnapshot(
    sessionId: string,
    workspaceFiles: Array<{ filePath: string; content: string }>,
    signals?: SnapshotSignals,
  ): Promise<ContextSnapshot> {
    const snapshot = await this.createSnapshot(sessionId, 'session_end', workspaceFiles);

    if (signals) {
      this.requireDb().prepare(
        'UPDATE context_snapshots SET signals = ? WHERE id = ?',
      ).run(JSON.stringify(signals), snapshot.id);
    }

    return snapshot;
  }

  /**
   * Get a snapshot by ID.
   */
  getSnapshot(snapshotId: string): ContextSnapshot | null {
    const db = this.requireDb();

    const row = db.prepare(
      'SELECT * FROM context_snapshots WHERE id = ?',
    ).get(snapshotId) as ContextSnapshotRow | undefined;

    if (!row) return null;

    const files = db.prepare(
      'SELECT * FROM snapshot_files WHERE snapshot_id = ?',
    ).all(snapshotId) as SnapshotFileRow[];

    return {
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      reason: row.reason as SnapshotReason,
      files: files.map((f) => ({
        filePath: f.file_path,
        hash: f.hash,
        sizeBytes: f.size_bytes,
        lineCount: f.line_count,
        content: f.content,
        truncated: f.truncated === 1,
        lastModified: f.last_modified,
      })),
      signals: row.signals ? (JSON.parse(row.signals) as SnapshotSignals) : undefined,
      totalSizeBytes: row.total_size_bytes,
    };
  }

  /**
   * Get snapshots for a session.
   */
  getSessionSnapshots(sessionId: string): ContextSnapshot[] {
    const db = this.requireDb();

    const rows = db.prepare(
      'SELECT * FROM context_snapshots WHERE session_id = ? ORDER BY timestamp DESC',
    ).all(sessionId) as ContextSnapshotRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      reason: row.reason as SnapshotReason,
      files: [], // Don't load all files for listing
      totalSizeBytes: row.total_size_bytes,
      signals: row.signals ? (JSON.parse(row.signals) as SnapshotSignals) : undefined,
    }));
  }

  /**
   * Get the most recent snapshot before a given time.
   */
  getLatestSnapshotBefore(timestamp: string): ContextSnapshot | null {
    const db = this.requireDb();

    const row = db.prepare(
      'SELECT * FROM context_snapshots WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1',
    ).get(timestamp) as ContextSnapshotRow | undefined;

    if (!row) return null;
    return this.getSnapshot(row.id);
  }

  // -------------------------------------------------------------------------
  // Pruning & Maintenance
  // -------------------------------------------------------------------------

  /**
   * Prune old snapshots for a session, keeping only the most recent N.
   */
  private pruneSessionSnapshots(sessionId: string): void {
    const db = this.requireDb();

    const maxSnapshots = this.config.maxSnapshotsPerSession;

    const count = db.prepare(
      'SELECT COUNT(*) as total FROM context_snapshots WHERE session_id = ?',
    ).get(sessionId) as CountRow | undefined;
    const total = count?.total ?? 0;

    if (total > maxSnapshots) {
      // Delete the oldest snapshots, keeping only the most recent
      const toDelete = db.prepare(`
        SELECT id FROM context_snapshots
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT ?
      `).all(sessionId, total - maxSnapshots) as Array<{ id: string }>;

      for (const row of toDelete) {
        db.prepare('DELETE FROM snapshot_files WHERE snapshot_id = ?').run(row.id);
        db.prepare('DELETE FROM context_snapshots WHERE id = ?').run(row.id);
      }

      log.debug(
        { sessionId, pruned: toDelete.length },
        'Pruned old snapshots for session',
      );
    }
  }

  /**
   * Prune history records older than the retention period.
   *
   * @returns Number of records removed.
   */
  pruneOldHistory(): number {
    const db = this.requireDb();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    const cutoff = cutoffDate.toISOString();

    const result = db.prepare(
      'DELETE FROM file_changes WHERE timestamp < ?',
    ).run(cutoff);

    // Also prune old snapshots
    db.prepare(
      'DELETE FROM context_snapshots WHERE timestamp < ?',
    ).run(cutoff);

    // Also prune old attributions
    db.prepare(
      'DELETE FROM session_attributions WHERE end_time < ?',
    ).run(cutoff);

    const recordsRemoved = result.changes;

    if (recordsRemoved > 0) {
      this.emit({ type: 'history_pruned', recordsRemoved });
      log.info({ recordsRemoved, cutoff }, 'Pruned old history records');
    }

    return recordsRemoved;
  }

  /**
   * Enforce the maximum records limit by deleting oldest records.
   */
  enforceMaxRecords(): number {
    const db = this.requireDb();

    const totalRow = db.prepare('SELECT COUNT(*) as total FROM file_changes').get() as CountRow | undefined;
    const total = totalRow?.total ?? 0;

    if (total <= this.config.maxRecords) return 0;

    const toRemove = total - this.config.maxRecords;
    db.prepare(`
      DELETE FROM file_changes WHERE id IN (
        SELECT id FROM file_changes ORDER BY timestamp ASC LIMIT ?
      )
    `).run(toRemove);

    log.info({ toRemove, total }, 'Enforced max records limit');

    return toRemove;
  }

  // -------------------------------------------------------------------------
  // Event System
  // -------------------------------------------------------------------------

  /**
   * Register an event handler.
   */
  on(event: 'change_recorded' | 'snapshot_created' | 'history_pruned' | 'attribution_updated', handler: (event: FileHistoryEvent) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: (event: FileHistoryEvent) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: FileHistoryEvent): void {
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          log.error({ err: String(err), eventType: event.type }, 'Event handler error');
        }
      }
    }
    // Also call handlers registered for all events
    const allHandlers = this.eventHandlers.get('*');
    if (allHandlers) {
      for (const handler of allHandlers) {
        try {
          handler(event);
        } catch (err) {
          log.error({ err: String(err) }, 'Event handler error');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      log.info('File history store closed');
    }
  }

  private requireDb(): Database {
    if (!this.initialized || !this.db) {
      throw new Error('FileHistoryStore not initialized. Call init() first.');
    }
    return this.db;
  }
}

/** Singleton instance. */
export const fileHistoryStore = new FileHistoryStore();