/**
 * @file learning/file-history-types.ts
 * @description Type definitions for Session Attribution & File History module.
 *
 * Tracks per-file change history with diffs, attributes changes to specific
 * sessions, and creates context snapshots for session continuity.
 *
 * Competitive context: Claude Code has 180KB session storage with file history
 * snapshots, per-file attribution, and context collapse snapshots. This module
 * provides SUDO-AI's equivalent session attribution and file history tracking.
 *
 * @module file-history-types
 */

// ---------------------------------------------------------------------------
// File Change Records
// ---------------------------------------------------------------------------

/** Type of file change operation. */
export type FileChangeType =
  | 'create'      // File was created
  | 'modify'      // File was modified (content changed)
  | 'delete'      // File was deleted
  | 'rename'      // File was renamed
  | 'move'        // File was moved to a new directory
  | 'chmod'       // File permissions changed
  | 'revert'      // File was reverted to a previous state
  | 'restore';    // File was restored from a backup

/** A single file change record. */
export interface FileChangeRecord {
  /** Unique ID for this change record (nanoid). */
  id: string;
  /** Session ID that made this change. */
  sessionId: string;
  /** Session's channel (telegram, discord, etc.). */
  channel: string;
  /** File path relative to project root. */
  filePath: string;
  /** Type of change. */
  changeType: FileChangeType;
  /** Timestamp of the change (ISO 8601). */
  timestamp: string;
  /** SHA-256 hash of the file content before the change (empty for creates). */
  hashBefore: string;
  /** SHA-256 hash of the file content after the change (empty for deletes). */
  hashAfter: string;
  /** Number of lines added. */
  linesAdded: number;
  /** Number of lines deleted. */
  linesDeleted: number;
  /** Unified diff of the change (empty for creates/deletes without prior content). */
  diff: string;
  /** Tool that made the change (e.g., 'coder.write-file', 'coder.edit-file'). */
  toolName: string;
  /** Description of what changed (human-readable). */
  description: string;
  /** Whether this change was auto-approved or required approval. */
  autoApproved: boolean;
  /** Total number of lines in the file after the change. */
  totalLines: number;
}

// ---------------------------------------------------------------------------
// Session Attribution
// ---------------------------------------------------------------------------

/** Attribution of a change to a session. */
export interface SessionAttribution {
  /** Session ID. */
  sessionId: string;
  /** Channel type. */
  channel: string;
  /** Peer/user ID within the channel. */
  peerId: string;
  /** Model used in the session. */
  model: string;
  /** Number of changes made in this session. */
  changeCount: number;
  /** Files changed in this session. */
  filesChanged: string[];
  /** Lines added across all files in this session. */
  totalLinesAdded: number;
  /** Lines deleted across all files in this session. */
  totalLinesDeleted: number;
  /** Session start time. */
  startTime: string;
  /** Session end time (or last activity). */
  endTime: string;
  /** Goal classification of the session. */
  goalType: string;
  /** Completion verdict of the session. */
  completionVerdict: string;
}

/** Summary of which sessions touched a file. */
export interface FileAttributionSummary {
  /** File path. */
  filePath: string;
  /** Total number of sessions that modified this file. */
  sessionCount: number;
  /** Total number of changes. */
  totalChanges: number;
  /** Sessions that modified this file (most recent first). */
  sessions: Array<{
    sessionId: string;
    channel: string;
    changeCount: number;
    lastChangeTime: string;
  }>;
}

// ---------------------------------------------------------------------------
// Context Snapshots
// ---------------------------------------------------------------------------

/** A snapshot of file state at a point in time. */
export interface ContextSnapshot {
  /** Unique ID for this snapshot (nanoid). */
  id: string;
  /** Session ID that triggered this snapshot. */
  sessionId: string;
  /** Timestamp of the snapshot. */
  timestamp: string;
  /** Reason for the snapshot. */
  reason: SnapshotReason;
  /** File states captured in this snapshot. */
  files: FileSnapshot[];
  /** Session signals at the time of the snapshot. */
  signals?: SnapshotSignals;
  /** Total size of all file contents in bytes. */
  totalSizeBytes: number;
}

/** Reason for creating a context snapshot. */
export type SnapshotReason =
  | 'session_start'      // Snapshot at session beginning
  | 'session_end'        // Snapshot at session end
  | 'compaction'         // Snapshot before context compaction
  | 'manual'             // Manually triggered snapshot
  | 'milestone'          // Automatic milestone (N changes)
  | 'rollback_point';    // Before a risky operation

/** A single file's state in a snapshot. */
export interface FileSnapshot {
  /** File path relative to project root. */
  filePath: string;
  /** SHA-256 hash of the file content. */
  hash: string;
  /** Size of the file in bytes. */
  sizeBytes: number;
  /** Number of lines. */
  lineCount: number;
  /** Content of the file (truncated to maxSizeBytes). */
  content: string;
  /** Whether the content was truncated. */
  truncated: boolean;
  /** Last modified timestamp. */
  lastModified: string;
}

/** Session signals captured in a snapshot. */
export interface SnapshotSignals {
  /** Number of turns in the session. */
  turnCount: number;
  /** Number of tool calls. */
  toolCallCount: number;
  /** Model used. */
  model: string;
  /** Feedback tier at snapshot time. */
  feedbackTier: string;
  /** Goal classification. */
  goalType: string;
}

// ---------------------------------------------------------------------------
// History Queries
// ---------------------------------------------------------------------------

/** Parameters for querying file history. */
export interface FileHistoryQuery {
  /** Filter by file path (supports glob patterns like "src/STAR/STAR.ts"). */
  filePathPattern?: string;
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by change type. */
  changeType?: FileChangeType;
  /** Filter by tool name. */
  toolName?: string;
  /** Start time (ISO 8601). */
  startTime?: string;
  /** End time (ISO 8601). */
  endTime?: string;
  /** Maximum number of results. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
}

/** Result of a file history query. */
export interface FileHistoryResult {
  /** Matching change records. */
  records: FileChangeRecord[];
  /** Total number of matching records (for pagination). */
  totalCount: number;
  /** Whether there are more results. */
  hasMore: boolean;
}

/** Statistics about file changes over time. */
export interface FileHistoryStats {
  /** Total number of changes recorded. */
  totalChanges: number;
  /** Total number of unique files changed. */
  uniqueFiles: number;
  /** Total number of unique sessions. */
  uniqueSessions: number;
  /** Changes by type. */
  changesByType: Record<FileChangeType, number>;
  /** Changes by tool. */
  changesByTool: Record<string, number>;
  /** Changes by day (ISO date string -> count). */
  changesByDay: Record<string, number>;
  /** Most changed files (top 10). */
  mostChangedFiles: Array<{ filePath: string; changeCount: number }>;
  /** Most active sessions (top 10). */
  mostActiveSessions: Array<{ sessionId: string; changeCount: number }>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the File History module. */
export interface FileHistoryConfig {
  /** Path to the SQLite database (default: 'data/file-history.db'). */
  dbPath: string;
  /** Maximum diff size to store in bytes (default: 50000). */
  maxDiffSizeBytes: number;
  /** Maximum file content to store in snapshots (default: 100000). */
  maxSnapshotFileSizeBytes: number;
  /** Maximum number of snapshots to keep per session (default: 10). */
  maxSnapshotsPerSession: number;
  /** Whether to automatically create snapshots (default: true). */
  autoSnapshot: boolean;
  /** Number of changes between auto-snapshots (default: 50). */
  snapshotInterval: number;
  /** Whether to track line-level diffs (default: true). */
  trackDiffs: boolean;
  /** Maximum number of history records to keep (default: 100000). */
  maxRecords: number;
  /** Days to retain history before pruning (default: 90). */
  retentionDays: number;
}

/** Default file history configuration. */
export const DEFAULT_FILE_HISTORY_CONFIG: FileHistoryConfig = {
  dbPath: 'data/file-history.db',
  maxDiffSizeBytes: 50_000,
  maxSnapshotFileSizeBytes: 100_000,
  maxSnapshotsPerSession: 10,
  autoSnapshot: true,
  snapshotInterval: 50,
  trackDiffs: true,
  maxRecords: 100_000,
  retentionDays: 90,
};

/** Events emitted by the file history module. */
export type FileHistoryEvent =
  | { type: 'change_recorded'; record: FileChangeRecord }
  | { type: 'snapshot_created'; snapshot: ContextSnapshot }
  | { type: 'history_pruned'; recordsRemoved: number }
  | { type: 'attribution_updated'; attribution: SessionAttribution };