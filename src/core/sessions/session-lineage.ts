/**
 * @file session-lineage.ts
 * @description Session lineage tracking with parent chains, frozen snapshots,
 * and FTS5 cross-session search for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's session lineage with parent_session_id chains
 * and frozen snapshots.
 *
 * Architecture:
 *   - Every session has an optional parent_session_id (set when forked or compacted)
 *   - At session start, all memory files are snapshotted (frozen, read-only for that session)
 *   - Cross-session FTS5 search enables finding relevant context from any past session
 *
 * Persistence is via the same better-sqlite3 / MindDB stack used throughout SUDO-AI.
 * The lineage table is created idempotently on first use.
 */

import { createLogger } from '../shared/logger.js';
import { contentHash } from '../shared/utils.js';
import type { SessionManager } from './manager.js';
import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const log = createLogger('sessions:lineage');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A node in the session lineage tree. Root sessions have depth 0. */
export interface SessionLineage {
  sessionId: string;
  parentId?: string;
  rootId: string;
  depth: number;
  createdAt: string;
  compactedAt?: string;
  forkReason?: string;
}

/** Frozen, read-only snapshot of memory files captured at session start. */
export interface FrozenSnapshot {
  sessionId: string;
  snapshotAt: string;
  files: { path: string; content: string; hash: string }[];
}

/** A search result from cross-session FTS5 query. */
export interface CrossSessionResult {
  sessionId: string;
  relevance: number;
  snippet: string;
  timestamp: string;
}

/** Configuration for the SessionLineageTracker. */
export interface LineageConfig {
  enableSnapshots: boolean;
  snapshotDir: string;
  maxLineageDepth: number;
  ftsSearchLimit: number;
}

const DEFAULT_CONFIG: Readonly<LineageConfig> = {
  enableSnapshots: true,
  snapshotDir: 'data/snapshots',
  maxLineageDepth: 50,
  ftsSearchLimit: 20,
};

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface LineageRow {
  session_id: string;
  parent_id: string | null;
  root_id: string;
  depth: number;
  created_at: string;
  compacted_at: string | null;
  fork_reason: string | null;
}

interface FtsResultRow {
  session_id: string;
  relevance: number;
  snippet: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// SessionLineageTracker
// ---------------------------------------------------------------------------

/**
 * Tracks session lineage chains, creates frozen snapshots, and provides
 * cross-session FTS5 search.
 */
export class SessionLineageTracker {
  private readonly sessionManager: SessionManager;
  private readonly config: Readonly<LineageConfig>;
  private readonly db: Database;
  private searchCount = 0;

  // Prepared statements — compiled once on first use
  private stmtInsertLineage: ReturnType<Database['prepare']> | null = null;
  private stmtGetLineage: ReturnType<Database['prepare']> | null = null;
  private stmtGetChildren: ReturnType<Database['prepare']> | null = null;

  constructor(sessionManager: SessionManager, config?: Partial<LineageConfig>) {
    this.sessionManager = sessionManager;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Reach through SessionManager to the underlying better-sqlite3 Database.
    // MindDB exposes `db` publicly; SessionManager holds MindDB as a private `db` field.
    const mindDb = (sessionManager as unknown as { db: { db: Database } }).db;
    this.db = mindDb.db;

    this._ensureSchema();

    if (this.config.enableSnapshots) {
      try { mkdirSync(this.config.snapshotDir, { recursive: true }); } catch (err) {
        log.warn({ dir: this.config.snapshotDir, err }, 'Cannot create snapshot directory');
      }
    }

    log.info(
      { enableSnapshots: this.config.enableSnapshots, snapshotDir: this.config.snapshotDir },
      'SessionLineageTracker initialized',
    );
  }

  // ---------------------------------------------------------------------------
  // Lineage recording
  // -------------------------------------------------------------------------

  /**
   * Record a lineage entry for a session.
   *
   * 1. Follows parent chains to find the root session.
   * 2. Calculates depth (0 for root, 1 for child of root, etc.).
   * 3. Persists to SQLite for durability.
   */
  recordLineage(sessionId: string, parentId?: string, forkReason?: string): SessionLineage {
    if (!sessionId) throw new TypeError('recordLineage: sessionId is required');

    // Walk the parent chain to find the root and compute depth
    let rootId = sessionId;
    let depth = 0;

    if (parentId) {
      const parentLineage = this._findLineageRow(parentId);
      if (parentLineage) {
        // Parent already has a lineage record — inherit its root and increment depth
        rootId = parentLineage.root_id;
        depth = parentLineage.depth + 1;
      } else {
        // Parent has no lineage record yet — treat parent as root
        rootId = parentId;
        depth = 1;
      }
    }

    // Guard against unreasonably deep lineage trees
    if (depth > this.config.maxLineageDepth) {
      log.warn(
        { sessionId, depth, maxDepth: this.config.maxLineageDepth },
        'Lineage depth exceeds configured limit — capping',
      );
      depth = this.config.maxLineageDepth;
    }

    const now = new Date().toISOString();
    const lineage: SessionLineage = { sessionId, parentId, rootId, depth, createdAt: now, forkReason };

    this._ensureStatements();
    this.stmtInsertLineage!.run({
      session_id: sessionId,
      parent_id: parentId ?? null,
      root_id: rootId,
      depth,
      created_at: now,
      fork_reason: forkReason ?? null,
    });

    log.debug({ sessionId, parentId, rootId, depth, forkReason }, 'Lineage recorded');
    return lineage;
  }

  // ---------------------------------------------------------------------------
  // Lineage queries
  // -------------------------------------------------------------------------

  /**
   * Return the full lineage chain from the given session up to the root.
   * Ordered from the given session (first) to the root (last).
   */
  getLineage(sessionId: string): SessionLineage[] {
    if (!sessionId) return [];

    const chain: SessionLineage[] = [];
    let current = sessionId;
    const visited = new Set<string>(); // cycle guard

    while (current) {
      if (visited.has(current)) {
        log.warn({ sessionId: current }, 'Cycle detected in lineage chain — breaking');
        break;
      }
      visited.add(current);

      const row = this._findLineageRow(current);
      if (!row) break;

      chain.push(this._mapRow(row));
      current = row.parent_id ?? ''; // empty string terminates the loop
    }

    return chain;
  }

  /** Return the root session of the lineage tree that `sessionId` belongs to. */
  getRootSession(sessionId: string): SessionLineage | null {
    if (!sessionId) return null;

    const lineage = this._findLineageRow(sessionId);
    if (!lineage) return null;

    // If this IS the root, return it directly
    if (lineage.root_id === sessionId) return this._mapRow(lineage);

    // Otherwise look up the root record
    const rootRow = this._findLineageRow(lineage.root_id);
    return rootRow ? this._mapRow(rootRow) : null;
  }

  /** Return all direct children of a given parent session. */
  getChildren(parentId: string): SessionLineage[] {
    if (!parentId) return [];
    this._ensureStatements();

    const rows = this.stmtGetChildren!.all(parentId) as LineageRow[];
    return rows.map((r) => this._mapRow(r));
  }

  // ---------------------------------------------------------------------------
  // Frozen snapshots
  // -------------------------------------------------------------------------

  /**
   * Create a frozen snapshot of memory files for the given session.
   * The snapshot is stored as a JSON file in the configured snapshot directory
   * and is immutable once written.
   */
  async createSnapshot(sessionId: string): Promise<FrozenSnapshot> {
    if (!sessionId) throw new TypeError('createSnapshot: sessionId is required');
    if (!this.config.enableSnapshots) {
      log.debug({ sessionId }, 'Snapshots disabled — skipping');
      return { sessionId, snapshotAt: new Date().toISOString(), files: [] };
    }

    const now = new Date().toISOString();
    const files: FrozenSnapshot['files'] = [];

    // Collect memory files from the MindDB chunks table — the session's world view
    try {
      const chunkRows = this.db
        .prepare<{ limit: number }, { path: string; text: string }>(
          `SELECT path, text FROM chunks WHERE source = 'memory' ORDER BY rowid DESC LIMIT :limit`,
        )
        .all({ limit: 200 });

      for (const row of chunkRows) {
        const hash = contentHash(row.text);
        files.push({ path: row.path, content: row.text, hash });
      }
    } catch (err) {
      log.warn({ sessionId, err }, 'Failed to read memory chunks for snapshot — recording empty');
    }

    const snapshot: FrozenSnapshot = { sessionId, snapshotAt: now, files };

    // Persist snapshot to disk as immutable JSON
    const snapshotPath = join(this.config.snapshotDir, `${sessionId}.json`);
    try {
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      log.info({ sessionId, fileCount: files.length, path: snapshotPath }, 'Frozen snapshot created');
    } catch (err) {
      log.error({ sessionId, path: snapshotPath, err }, 'Failed to write snapshot file');
    }

    return snapshot;
  }

  /** Load a previously created snapshot for a session. Returns null if none exists. */
  loadSnapshot(sessionId: string): FrozenSnapshot | null {
    if (!sessionId) return null;

    const snapshotPath = join(this.config.snapshotDir, `${sessionId}.json`);
    if (!existsSync(snapshotPath)) {
      log.debug({ sessionId, path: snapshotPath }, 'No snapshot file found');
      return null;
    }

    try {
      const raw = readFileSync(snapshotPath, 'utf-8');
      return JSON.parse(raw) as FrozenSnapshot;
    } catch (err) {
      log.error({ sessionId, path: snapshotPath, err }, 'Failed to read snapshot file');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-session FTS5 search
  // -------------------------------------------------------------------------

  /**
   * Search across all session message content using FTS5.
   * Results are ranked by BM25 relevance and returned with session IDs and snippets.
   *
   * @param query - FTS5 search query (supports AND, OR, NOT, * for prefix).
   * @param limit - Maximum results to return (default: from config).
   */
  searchAcrossSessions(query: string, limit?: number): CrossSessionResult[] {
    if (!query?.trim()) return [];

    const maxResults = Math.min(limit ?? this.config.ftsSearchLimit, 100);
    this.searchCount++;

    try {
      // BM25 returns negative values (more negative = more relevant). Negate so higher = better.
      // FTS5 MATCH does not support named params — positional binding is used.
      const rows = this.db
        .prepare(`
          SELECT
            m.session_id,
            -bm25(session_messages_fts) AS relevance,
            SUBSTR(m.content, 1, 300)  AS snippet,
            m.created_at               AS timestamp
          FROM session_messages_fts fts
          JOIN messages m ON m.id = fts.rowid
          WHERE session_messages_fts MATCH ?
          ORDER BY relevance DESC, m.created_at DESC
          LIMIT ?
        `)
        .all(query, maxResults) as unknown as FtsResultRow[];

      const results: CrossSessionResult[] = rows.map((r) => ({
        sessionId: r.session_id,
        relevance: Math.round(r.relevance * 100) / 100,
        snippet: r.snippet,
        timestamp: r.timestamp,
      }));

      log.debug({ query: query.slice(0, 60), resultCount: results.length }, 'Cross-session search');
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ query: query.slice(0, 80), err: msg }, 'FTS5 search failed — returning empty');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /** Return operational statistics for the lineage tracker. */
  getStats(): { totalLineages: number; totalSnapshots: number; avgDepth: number; searchCount: number } {
    let totalLineages = 0;
    let avgDepth = 0;

    try {
      const countRow = this.db
        .prepare<Record<string, never>, { cnt: number }>(`SELECT COUNT(*) AS cnt FROM session_lineage`)
        .get({}) as { cnt: number } | undefined;
      totalLineages = countRow?.cnt ?? 0;

      if (totalLineages > 0) {
        const avgRow = this.db
          .prepare<Record<string, never>, { avg: number }>(`SELECT AVG(depth) AS avg FROM session_lineage`)
          .get({}) as { avg: number } | undefined;
        avgDepth = Math.round((avgRow?.avg ?? 0) * 100) / 100;
      }
    } catch (err) {
      log.warn({ err }, 'Failed to query lineage stats');
    }

    // Count snapshot files on disk
    let totalSnapshots = 0;
    try {
      const entries = readdirSync(this.config.snapshotDir);
      totalSnapshots = entries.filter((e: string) => e.endsWith('.json')).length;
    } catch {
      // directory may not exist yet
    }

    return { totalLineages, totalSnapshots, avgDepth, searchCount: this.searchCount };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Create the session_lineage table and indexes if they don't exist. */
  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_lineage (
        session_id   TEXT PRIMARY KEY,
        parent_id    TEXT,
        root_id      TEXT NOT NULL,
        depth        INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        compacted_at TEXT,
        fork_reason  TEXT,
        FOREIGN KEY (parent_id) REFERENCES session_lineage(session_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lineage_parent_id ON session_lineage(parent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lineage_root_id   ON session_lineage(root_id)`);
    log.debug('_ensureSchema: lineage tables ready');
  }

  /** Compile prepared statements lazily (after schema is guaranteed to exist). */
  private _ensureStatements(): void {
    if (this.stmtInsertLineage) return;

    this.stmtInsertLineage = this.db.prepare(`
      INSERT OR REPLACE INTO session_lineage
        (session_id, parent_id, root_id, depth, created_at, fork_reason)
      VALUES
        (:session_id, :parent_id, :root_id, :depth, :created_at, :fork_reason)
    `);
    this.stmtGetLineage = this.db.prepare(
      `SELECT * FROM session_lineage WHERE session_id = ?`,
    );
    this.stmtGetChildren = this.db.prepare(
      `SELECT * FROM session_lineage WHERE parent_id = ? ORDER BY created_at ASC`,
    );
  }

  /** Look up a single lineage row from the DB. */
  private _findLineageRow(sessionId: string): LineageRow | null {
    this._ensureStatements();
    const row = this.stmtGetLineage!.get(sessionId) as LineageRow | undefined;
    return row ?? null;
  }

  /** Map an internal DB row to the public SessionLineage interface. */
  private _mapRow(row: LineageRow): SessionLineage {
    return {
      sessionId: row.session_id,
      parentId: row.parent_id ?? undefined,
      rootId: row.root_id,
      depth: row.depth,
      createdAt: row.created_at,
      compactedAt: row.compacted_at ?? undefined,
      forkReason: row.fork_reason ?? undefined,
    };
  }
}