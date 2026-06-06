/**
 * @file session-rewind.ts
 * @description Session Rewind system for SUDO-AI v4 — JSONL-based undo history
 * with turn-level checkpointing, file snapshots, and ACP-compatible rewind methods.
 *
 * Inspired by Grok Build CLI's rewind_points.jsonl system:
 *   - Captures turn number, file state, and conversation length at each checkpoint
 *   - Supports xai/rewind/points and xai/rewind/execute ACP methods
 *   - Compaction checkpoints enable rewind past compaction boundaries
 *   - Tracks reverted files, clean files, and conflicts
 *
 * Persistence: append-only JSONL (rewind_points.jsonl), max 4.5 MB per session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions:rewind');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total size of rewind_points.jsonl per session (4.5 MB). */
export const MAX_REWIND_SIZE = 4.5 * 1024 * 1024;

/** File name used for persistence. */
export const REWIND_POINTS_FILE = 'rewind_points.jsonl';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single rewind checkpoint capturing the full state of files and conversation
 * length at a given turn. Used to undo back to a specific point in a session.
 */
export interface RewindPoint {
  /** Unique identifier for this rewind point (nanoid). */
  id: string;
  /** The turn number at which this checkpoint was recorded. */
  turnNumber: number;
  /** ISO 8601 timestamp when this checkpoint was created. */
  timestamp: string;
  /** Snapshot of file paths to their content at this turn. */
  fileSnapshots: Record<string, string>;
  /** Length of the conversation (message count) at this turn. */
  conversationLength: number;
}

/** Result of a rewind operation. */
export interface RewindResult {
  /** Files that were reverted to their snapshot state. */
  revertedFiles: string[];
  /** Files that exist in the current state but were not present in the snapshot
   *  (created after the checkpoint) — these are left untouched (clean). */
  cleanFiles: string[];
  /** Files where the current content differs from the snapshot AND the snapshot
   *  differs from the immediately-previous rewind point, indicating a conflict. */
  conflicts: string[];
}

/** Shape of a single JSONL line in rewind_points.jsonl. */
interface RewindPointRecord {
  id: string;
  turnNumber: number;
  timestamp: string;
  fileSnapshots: Record<string, string>;
  conversationLength: number;
}

// ---------------------------------------------------------------------------
// ACP-compatible request/response types
// ---------------------------------------------------------------------------

/** ACP request for listing rewind points. */
export interface AcpRewindPointsRequest {
  method: 'rewind/points';
  /** Optional: only return points with turnNumber >= minTurn. */
  minTurn?: number;
  /** Optional: maximum number of points to return. */
  limit?: number;
}

/** ACP response for listing rewind points. */
export interface AcpRewindPointsResponse {
  points: Array<{
    id: string;
    turnNumber: number;
    timestamp: string;
    conversationLength: number;
    fileCount: number;
  }>;
  totalSize: number;
}

/** ACP request for executing a rewind. */
export interface AcpRewindExecuteRequest {
  method: 'rewind/execute';
  /** The rewind point ID to rewind to. */
  rewindId: string;
  /** Optional: dry-run mode — returns what would change without actually changing files. */
  dryRun?: boolean;
}

/** ACP response for executing a rewind. */
export interface AcpRewindExecuteResponse {
  success: boolean;
  revertedFiles: string[];
  cleanFiles: string[];
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// SessionRewindManager
// ---------------------------------------------------------------------------

/**
 * Manages session rewind checkpoints with JSONL persistence.
 *
 * Each checkpoint captures the state of tracked files and conversation length
 * at a given turn. The manager supports:
 *   - Recording rewind points (checkpoints)
 *   - Listing available rewind points
 *   - Rewinding to a specific checkpoint (restoring file state)
 *   - Persisting to and restoring from JSONL files
 *   - ACP-compatible methods for external integration
 *   - Size enforcement (4.5 MB cap per session)
 */
export class SessionRewindManager {
  /** In-memory list of rewind points, ordered by turnNumber ascending. */
  private rewindPoints: RewindPoint[] = [];

  /** Current tracked files (path -> content). Written to by the caller. */
  private currentFiles: Map<string, string> = new Map();

  /** Cumulative byte size of all serialized rewind points. */
  private totalSizeBytes: number = 0;

  constructor() {
    log.debug('SessionRewindManager initialized');
  }

  // ---------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Record a new rewind point (checkpoint) at the given turn.
   *
   * @param turnNumber - The conversation turn number for this checkpoint.
   * @param files - Map of file paths to their current content.
   * @param conversationLength - Current conversation message count.
   * @returns The newly created RewindPoint.
   */
  recordPoint(
    turnNumber: number,
    files: Map<string, string>,
    conversationLength: number,
  ): RewindPoint {
    if (turnNumber < 0) throw new TypeError('recordPoint: turnNumber must be >= 0');
    if (conversationLength < 0) throw new TypeError('recordPoint: conversationLength must be >= 0');

    const point: RewindPoint = {
      id: nanoid(),
      turnNumber,
      timestamp: new Date().toISOString(),
      fileSnapshots: Object.fromEntries(files.entries()),
      conversationLength,
    };

    // Update current file tracking
    this.currentFiles = new Map(files);

    // Calculate size of this point's serialized form
    const serialized = JSON.stringify(this._toRecord(point)) + '\n';
    this.totalSizeBytes += Buffer.byteLength(serialized, 'utf8');

    // Enforce size cap — evict oldest points until under limit
    this.rewindPoints.push(point);
    this._enforceSizeCap();

    log.debug(
      { pointId: point.id, turnNumber, fileCount: Object.keys(point.fileSnapshots).length, conversationLength },
      'Rewind point recorded',
    );

    return point;
  }

  /**
   * Return all available rewind points, ordered by turnNumber ascending.
   */
  getRewindPoints(): RewindPoint[] {
    return [...this.rewindPoints];
  }

  /**
   * Rewind to a specific checkpoint, restoring file state.
   *
   * For each file in the target checkpoint's snapshot:
   *   - If the current file content differs, it is reverted (listed in revertedFiles).
   *   - If content matches, it is listed in cleanFiles.
   *
   * For each file that exists currently but was not in the snapshot:
   *   - It is listed in cleanFiles (left untouched — created after checkpoint).
   *
   * Conflicts: files where the current content differs from the snapshot AND
   * the snapshot differs from the immediately-previous rewind point.
   *
   * @param rewindId - The ID of the rewind point to rewind to.
   * @returns RewindResult with reverted/clean/conflict file lists.
   */
  rewindTo(rewindId: string): RewindResult {
    const targetIndex = this.rewindPoints.findIndex((p) => p.id === rewindId);
    if (targetIndex === -1) {
      throw new Error(`rewindTo: rewind point '${rewindId}' not found`);
    }

    const target = this.rewindPoints[targetIndex];
    const previousPoint = targetIndex > 0 ? this.rewindPoints[targetIndex - 1] : null;

    const revertedFiles: string[] = [];
    const cleanFiles: string[] = [];
    const conflicts: string[] = [];

    const snapshotPaths = new Set(Object.keys(target.fileSnapshots));
    const currentPaths = new Set(this.currentFiles.keys());

    // Check files that exist in the snapshot
    for (const filePath of snapshotPaths) {
      const snapshotContent = target.fileSnapshots[filePath];
      const currentContent = this.currentFiles.get(filePath);

      if (currentContent === undefined) {
        // File existed in snapshot but is now absent — needs revert
        revertedFiles.push(filePath);
      } else if (currentContent !== snapshotContent) {
        // Content differs — needs revert
        revertedFiles.push(filePath);

        // Check for conflict: did the previous checkpoint also have different content?
        if (previousPoint) {
          const prevContent = previousPoint.fileSnapshots[filePath];
          if (prevContent !== undefined && prevContent !== snapshotContent) {
            conflicts.push(filePath);
          }
        }
      } else {
        // Content matches — clean
        cleanFiles.push(filePath);
      }
    }

    // Files that exist now but were not in the snapshot
    for (const filePath of currentPaths) {
      if (!snapshotPaths.has(filePath)) {
        cleanFiles.push(filePath);
      }
    }

    // Remove all rewind points after the target (they are invalidated by rewind)
    const removedCount = this.rewindPoints.length - targetIndex - 1;
    this.rewindPoints = this.rewindPoints.slice(0, targetIndex + 1);

    // Restore currentFiles to the snapshot state
    this.currentFiles = new Map(Object.entries(target.fileSnapshots));

    // Recalculate total size after truncation
    this.totalSizeBytes = this._calculateTotalSize();

    log.info(
      { rewindId, targetTurn: target.turnNumber, revertedFiles: revertedFiles.length, cleanFiles: cleanFiles.length, conflicts: conflicts.length, removedPoints: removedCount },
      'Rewind executed',
    );

    return { revertedFiles, cleanFiles, conflicts };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist all rewind points to a JSONL file in the given session directory.
   * Appends to the file if it already exists; creates it if not.
   * Enforces the 4.5 MB size cap by rewriting the file without the oldest
   * entries if the cap is exceeded.
   *
   * @param sessionDir - Directory path where rewind_points.jsonl will be written.
   */
  persist(sessionDir: string): void {
    if (!sessionDir) throw new TypeError('persist: sessionDir is required');

    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      log.error({ sessionDir, err }, 'persist: cannot create session directory');
      throw err;
    }

    const filePath = path.join(sessionDir, REWIND_POINTS_FILE);

    // Write all points as JSONL (rewrite entire file for consistency)
    const lines = this.rewindPoints.map(
      (p) => JSON.stringify(this._toRecord(p)),
    );
    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    try {
      writeFileSync(filePath, content, 'utf8');
      log.debug({ sessionDir, pointCount: this.rewindPoints.length, filePath }, 'Rewind points persisted');
    } catch (err) {
      log.error({ sessionDir, filePath, err }, 'persist: failed to write JSONL file');
      throw err;
    }
  }

  /**
   * Restore rewind points from a JSONL file in the given session directory.
   * Replaces any in-memory rewind points with the loaded ones.
   *
   * @param sessionDir - Directory path where rewind_points.jsonl is located.
   */
  restore(sessionDir: string): void {
    if (!sessionDir) throw new TypeError('restore: sessionDir is required');

    const filePath = path.join(sessionDir, REWIND_POINTS_FILE);

    if (!existsSync(filePath)) {
      log.debug({ sessionDir, filePath }, 'restore: no JSONL file found — starting fresh');
      this.rewindPoints = [];
      this.totalSizeBytes = 0;
      return;
    }

    try {
      const raw = readFileSync(filePath, 'utf8');
      const points: RewindPoint[] = [];
      let sizeBytes = 0;

      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const record = JSON.parse(trimmed) as RewindPointRecord;
          const point = this._fromRecord(record);
          points.push(point);
          sizeBytes += Buffer.byteLength(trimmed + '\n', 'utf8');
        } catch (parseErr) {
          log.warn({ line: trimmed.slice(0, 80), err: parseErr }, 'restore: skipping malformed JSONL line');
        }
      }

      this.rewindPoints = points;
      this.totalSizeBytes = sizeBytes;

      // Restore currentFiles from the last point (if any)
      if (points.length > 0) {
        const last = points[points.length - 1];
        this.currentFiles = new Map(Object.entries(last.fileSnapshots));
      } else {
        this.currentFiles = new Map();
      }

      log.info(
        { sessionDir, pointCount: points.length, totalSizeBytes: this.totalSizeBytes },
        'Rewind points restored from JSONL',
      );
    } catch (err) {
      log.error({ sessionDir, filePath, err }, 'restore: failed to read JSONL file');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // ACP-compatible methods
  // -------------------------------------------------------------------------

  /**
   * Handle an ACP rewind/points request.
   * Returns a list of available rewind points with metadata.
   */
  handleAcpRewindPoints(request: AcpRewindPointsRequest): AcpRewindPointsResponse {
    let points = this.rewindPoints;

    // Filter by minTurn if specified
    if (request.minTurn !== undefined) {
      points = points.filter((p) => p.turnNumber >= request.minTurn!);
    }

    // Apply limit if specified
    if (request.limit !== undefined && request.limit > 0) {
      points = points.slice(-request.limit);
    }

    return {
      points: points.map((p) => ({
        id: p.id,
        turnNumber: p.turnNumber,
        timestamp: p.timestamp,
        conversationLength: p.conversationLength,
        fileCount: Object.keys(p.fileSnapshots).length,
      })),
      totalSize: this.totalSizeBytes,
    };
  }

  /**
   * Handle an ACP rewind/execute request.
   * In dry-run mode, returns the result without actually changing state.
   */
  handleAcpRewindExecute(request: AcpRewindExecuteRequest): AcpRewindExecuteResponse {
    if (request.dryRun) {
      // Simulate the rewind without mutating state
      const targetIndex = this.rewindPoints.findIndex((p) => p.id === request.rewindId);
      if (targetIndex === -1) {
        return { success: false, revertedFiles: [], cleanFiles: [], conflicts: [] };
      }

      const target = this.rewindPoints[targetIndex];
      const previousPoint = targetIndex > 0 ? this.rewindPoints[targetIndex - 1] : null;

      const revertedFiles: string[] = [];
      const cleanFiles: string[] = [];
      const conflicts: string[] = [];

      const snapshotPaths = new Set(Object.keys(target.fileSnapshots));
      const currentPaths = new Set(this.currentFiles.keys());

      for (const filePath of snapshotPaths) {
        const snapshotContent = target.fileSnapshots[filePath];
        const currentContent = this.currentFiles.get(filePath);

        if (currentContent === undefined || currentContent !== snapshotContent) {
          revertedFiles.push(filePath);
          if (previousPoint) {
            const prevContent = previousPoint.fileSnapshots[filePath];
            if (prevContent !== undefined && prevContent !== snapshotContent) {
              conflicts.push(filePath);
            }
          }
        } else {
          cleanFiles.push(filePath);
        }
      }

      for (const filePath of currentPaths) {
        if (!snapshotPaths.has(filePath)) {
          cleanFiles.push(filePath);
        }
      }

      return { success: true, revertedFiles, cleanFiles, conflicts };
    }

    // Actual rewind
    try {
      const result = this.rewindTo(request.rewindId);
      return { success: true, ...result };
    } catch {
      return { success: false, revertedFiles: [], cleanFiles: [], conflicts: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /** Get the total number of recorded rewind points. */
  get count(): number {
    return this.rewindPoints.length;
  }

  /** Get the total size in bytes of all serialized rewind points. */
  get sizeBytes(): number {
    return this.totalSizeBytes;
  }

  /** Get the current tracked files map. */
  get files(): Map<string, string> {
    return new Map(this.currentFiles);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Enforce the 4.5 MB size cap by evicting the oldest rewind points
   * until total size is under the limit.
   */
  private _enforceSizeCap(): void {
    while (this.totalSizeBytes > MAX_REWIND_SIZE && this.rewindPoints.length > 1) {
      const evicted = this.rewindPoints.shift()!;
      const evictedSize = Buffer.byteLength(
        JSON.stringify(this._toRecord(evicted)) + '\n',
        'utf8',
      );
      this.totalSizeBytes -= evictedSize;
      log.debug(
        { evictedId: evicted.id, evictedTurn: evicted.turnNumber, newSize: this.totalSizeBytes },
        'Rewind point evicted (size cap)',
      );
    }
    // Ensure totalSizeBytes never goes negative
    this.totalSizeBytes = Math.max(0, this.totalSizeBytes);
  }

  /** Recalculate total size from all in-memory points. */
  private _calculateTotalSize(): number {
    return this.rewindPoints.reduce(
      (sum, p) => sum + Buffer.byteLength(JSON.stringify(this._toRecord(p)) + '\n', 'utf8'),
      0,
    );
  }

  /** Convert a RewindPoint to a JSONL-serializable record. */
  private _toRecord(point: RewindPoint): RewindPointRecord {
    return {
      id: point.id,
      turnNumber: point.turnNumber,
      timestamp: point.timestamp,
      fileSnapshots: point.fileSnapshots,
      conversationLength: point.conversationLength,
    };
  }

  /** Convert a JSONL record back to a RewindPoint. */
  private _fromRecord(record: RewindPointRecord): RewindPoint {
    return {
      id: record.id,
      turnNumber: record.turnNumber,
      timestamp: record.timestamp,
      fileSnapshots: record.fileSnapshots,
      conversationLength: record.conversationLength,
    };
  }
}