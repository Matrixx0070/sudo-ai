/**
 * @file unified.ts
 * @description UnifiedMemory — cross-store search across mind.db,
 * consciousness.db, knowledge.db, and workspace files.
 * Raw SQL is delegated to unified-stores.ts.  All DB access is synchronous.
 */

import Database from 'better-sqlite3';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { forgeInsights } from './insight-forge.js';
import type { ForgeResult, ForgeOptions, SubQuestion } from './insight-forge.js';
import {
  queryMindChunks,
  queryMindMessages,
  queryMindTasks,
  queryThoughts,
  queryEpisodes,
  queryKgNodes,
  searchWorkspaceFiles,
  countTable,
} from './unified-stores.js';
import { guardMemoryWrite } from './injection-scanner.js';
import type { MemoryType6 } from './memory-taxonomy.js';
import { DATA_DIR as RESOLVED_DATA_DIR, WORKSPACE_DIR as RESOLVED_WORKSPACE_DIR } from '../shared/paths.js';

const log = createLogger('memory:unified');

const DATA_DIR      = RESOLVED_DATA_DIR;
const WORKSPACE_DIR = RESOLVED_WORKSPACE_DIR;

const MIND_DB             = join(DATA_DIR, 'mind.db');
const CONSCIOUSNESS_DB    = join(DATA_DIR, 'consciousness.db');
const KNOWLEDGE_DB        = join(DATA_DIR, 'knowledge.db');
const STRUCTURED_MEM_DIR  = join(DATA_DIR, 'structured-memory');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryResult {
  content:    string;
  source:     'mind' | 'consciousness' | 'knowledge' | 'workspace' | 'tasks';
  table?:     string;
  relevance:  number;
  timestamp?: string;
  metadata?:  Record<string, unknown>;
}

export interface MemoryQuery {
  query: string; sources?: string[]; limit?: number;
  type?: 'keyword' | 'recent' | 'all';
}

export interface MemorySummary {
  sessions: number; messages: number; thoughts: number;
  concepts: number; episodes: number; skills: number;
  errors: number; workspaceFiles: number;
}

export interface SessionWithCount {
  id: string; title: string | null; model: string;
  created_at: string; message_count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function openReadonly(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) {
    log.warn({ dbPath }, 'Database not found — skipping');
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    log.error({ dbPath, err: String(err) }, 'Failed to open database');
    return null;
  }
}

function wantsSource(sources: string[] | undefined, name: string): boolean {
  return !sources || sources.length === 0 || sources.includes(name);
}

function listWorkspaceFiles(): string[] {
  if (!existsSync(WORKSPACE_DIR)) return [];
  try {
    return (readdirSync(WORKSPACE_DIR) as string[])
      .filter(f => ['.md', '.txt', '.json'].includes(extname(f)))
      .map(f => join(WORKSPACE_DIR, f));
  } catch (err) {
    log.warn({ err: String(err) }, 'listWorkspaceFiles error');
    return [];
  }
}

/**
 * Synchronous keyword search across the structured-memory JSON store.
 * Covers all six MemoryType6 taxonomy types stored in data/structured-memory/.
 * Scoring mirrors structured-memory.ts: name=3, description=2, content=1 per term.
 */
function searchStructuredMemories(q: string, limit: number): MemoryResult[] {
  if (!existsSync(STRUCTURED_MEM_DIR)) return [];

  let files: string[];
  try {
    files = readdirSync(STRUCTURED_MEM_DIR).filter(f => f.endsWith('.json'));
  } catch (err) {
    log.warn({ err: String(err) }, 'searchStructuredMemories: readdir failed');
    return [];
  }

  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results: MemoryResult[] = [];

  for (const filename of files) {
    const fp = join(STRUCTURED_MEM_DIR, filename);
    let record: { id?: string; type?: MemoryType6; name?: string; description?: string; content?: string; updatedAt?: string } = {};
    try {
      record = JSON.parse(readFileSync(fp, 'utf-8'));
    } catch {
      continue; // skip unreadable or malformed files
    }

    if (!record.content) continue;

    const nameLower    = (record.name        ?? '').toLowerCase();
    const descLower    = (record.description ?? '').toLowerCase();
    const contentLower = record.content.toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (nameLower.includes(term))    score += 3;
      if (descLower.includes(term))    score += 2;
      if (contentLower.includes(term)) score += 1;
    }

    if (score === 0) continue;

    results.push({
      content:   record.content,
      source:    'knowledge',
      table:     `structured:${record.type ?? 'unknown'}`,
      relevance: score / (terms.length * 6), // normalise to 0-1 range
      timestamp: record.updatedAt,
      metadata:  { id: record.id, name: record.name, type: record.type },
    });
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// UnifiedMemory
// ---------------------------------------------------------------------------

export class UnifiedMemory {

  /**
   * Keyword search across all enabled stores.
   * Results are sorted descending by relevance score.
   */
  search(query: MemoryQuery): MemoryResult[] {
    if (!query.query?.trim()) {
      log.warn('search called with empty query');
      return [];
    }

    const { query: q, sources, limit = 20 } = query;
    const pattern = `%${q}%`;
    const results: MemoryResult[] = [];

    log.info({ q, sources, limit }, 'Unified memory search');

    if (wantsSource(sources, 'mind')) {
      const db = openReadonly(MIND_DB);
      if (db) {
        try {
          results.push(...queryMindChunks(db, pattern, q));
          results.push(...queryMindMessages(db, pattern, q));
        } catch (err) { log.error({ err: String(err) }, 'mind search error'); }
        finally { db.close(); }
      }
    }

    if (wantsSource(sources, 'tasks')) {
      const db = openReadonly(MIND_DB);
      if (db) {
        try { results.push(...queryMindTasks(db, pattern, q)); }
        catch (err) { log.error({ err: String(err) }, 'tasks search error'); }
        finally { db.close(); }
      }
    }

    if (wantsSource(sources, 'consciousness')) {
      const db = openReadonly(CONSCIOUSNESS_DB);
      if (db) {
        try {
          results.push(...queryThoughts(db, pattern, q));
          results.push(...queryEpisodes(db, pattern, q));
        } catch (err) { log.error({ err: String(err) }, 'consciousness search error'); }
        finally { db.close(); }
      }
    }

    if (wantsSource(sources, 'knowledge')) {
      const db = openReadonly(KNOWLEDGE_DB);
      if (db) {
        try { results.push(...queryKgNodes(db, pattern, q)); }
        catch (err) { log.error({ err: String(err) }, 'knowledge search error'); }
        finally { db.close(); }
      }
    }

    if (wantsSource(sources, 'workspace')) {
      results.push(...searchWorkspaceFiles(listWorkspaceFiles(), q));
    }

    if (wantsSource(sources, 'structured')) {
      try {
        results.push(...searchStructuredMemories(q, limit));
      } catch (err) { log.error({ err: String(err) }, 'structured memory search error'); }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    const capped = results.slice(0, limit);
    log.info({ found: results.length, returned: capped.length }, 'Search complete');
    return capped;
  }

  // -------------------------------------------------------------------------

  /**
   * Search using InsightForge: decomposes the query into sub-questions,
   * runs hybrid search in parallel for each, and merges results with RRF.
   */
  async searchWithForge(
    query: string,
    decomposeQueryFn: (query: string, maxSubs: number) => Promise<SubQuestion[]>,
    options?: ForgeOptions,
  ): Promise<ForgeResult<MemoryResult>> {
    const searchFn = async (q: string, limit = 8) => {
      return this.search({ query: q, limit });
    };
    // MemoryResult has no id field; content is its identity for RRF dedupe.
    return forgeInsights(searchFn, decomposeQueryFn, query, { idKey: 'content', ...options });
  }

  // -------------------------------------------------------------------------

  /** Most recent items across all stores, merged and sorted by timestamp. */
  getRecent(limit = 20): MemoryResult[] {
    const results: MemoryResult[] = [];

    const mind = openReadonly(MIND_DB);
    if (mind) {
      try {
        for (const row of mind.prepare<{ l: number }, { content: string; role: string; created_at: string; session_id: string }>(
          `SELECT content, role, created_at, session_id FROM messages ORDER BY id DESC LIMIT :l`,
        ).all({ l: Math.ceil(limit / 2) })) {
          results.push({ content: row.content, source: 'mind', table: 'messages',
            relevance: 0.5, timestamp: row.created_at, metadata: { role: row.role, session_id: row.session_id } });
        }
        for (const row of mind.prepare<{ l: number }, { text: string; source: string; created_at: string }>(
          `SELECT text, source, created_at FROM chunks WHERE superseded_by IS NULL ORDER BY id DESC LIMIT :l`,
        ).all({ l: Math.ceil(limit / 3) })) {
          results.push({ content: row.text, source: 'mind', table: 'chunks',
            relevance: 0.4, timestamp: row.created_at, metadata: { subSource: row.source } });
        }
      } catch (err) { log.error({ err: String(err) }, 'getRecent mind error'); }
      finally { mind.close(); }
    }

    const cdb = openReadonly(CONSCIOUSNESS_DB);
    if (cdb) {
      try {
        for (const row of cdb.prepare<{ l: number }, { content: string; tier: string; created_at: string }>(
          `SELECT content, tier, created_at FROM thoughts ORDER BY created_at DESC LIMIT :l`,
        ).all({ l: Math.ceil(limit / 3) })) {
          results.push({ content: row.content, source: 'consciousness', table: 'thoughts',
            relevance: 0.4, timestamp: row.created_at, metadata: { tier: row.tier } });
        }
      } catch (err) { log.error({ err: String(err) }, 'getRecent consciousness error'); }
      finally { cdb.close(); }
    }

    results.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    return results.slice(0, limit);
  }

  // -------------------------------------------------------------------------

  /** Row counts across all stores. */
  summarize(): MemorySummary {
    const s: MemorySummary = { sessions: 0, messages: 0, thoughts: 0,
      concepts: 0, episodes: 0, skills: 0, errors: 0, workspaceFiles: 0 };

    const mind = openReadonly(MIND_DB);
    if (mind) {
      try {
        s.sessions = countTable(mind, 'sessions');
        s.messages = countTable(mind, 'messages');
        s.skills   = countTable(mind, 'skills');
        s.errors   = countTable(mind, 'error_memory');
      } finally { mind.close(); }
    }

    const cdb = openReadonly(CONSCIOUSNESS_DB);
    if (cdb) {
      try {
        s.thoughts = countTable(cdb, 'thoughts');
        s.concepts = countTable(cdb, 'concept_nodes');
        s.episodes = countTable(cdb, 'episodes');
      } finally { cdb.close(); }
    }

    s.workspaceFiles = listWorkspaceFiles().length;
    log.info(s, 'Memory summarized');
    return s;
  }

  // -------------------------------------------------------------------------

  /**
   * Persists a new insight chunk into mind.db (write mode).
   * Deduplicates by SHA-256 hash before inserting.
   * @throws MemoryInjectionError when content contains injection patterns in strict mode.
   */
  saveInsight(content: string, category = 'learning'): void {
    if (!content?.trim()) { log.warn('saveInsight: empty content'); return; }
    if (!existsSync(MIND_DB)) { log.warn('mind.db missing — cannot save insight'); return; }
    // Security: scan for prompt-injection before persisting.
    const safeContent = guardMemoryWrite(content, 'UnifiedMemory.saveInsight');
    try {
      const db   = new Database(MIND_DB);
      db.pragma('journal_mode = WAL');
      const hash = createHash('sha256').update(safeContent, 'utf8').digest('hex');
      const dupe = db.prepare<{ hash: string }, { id: number }>('SELECT id FROM chunks WHERE hash = :hash').get({ hash });
      if (!dupe) {
        db.prepare(`INSERT INTO chunks (text, path, source, hash, is_evergreen)
                    VALUES (:text, :path, :source, :hash, 0)`)
          .run({ text: safeContent, path: `insight:${category}`, source: 'learning', hash });
        log.info({ category, len: content.length }, 'Insight saved');
      } else {
        log.debug({ hash }, 'Insight duplicate — skipped');
      }
      db.close();
    } catch (err) {
      log.error({ err: String(err) }, 'saveInsight failed');
    }
  }

  // -------------------------------------------------------------------------

  /** Recent sessions with message counts from mind.db. */
  getSessionHistory(limit = 10): SessionWithCount[] {
    const db = openReadonly(MIND_DB);
    if (!db) return [];
    try {
      return db.prepare<{ l: number }, SessionWithCount>(`
        SELECT s.id, s.title, s.model, s.created_at,
               COUNT(m.id) AS message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT :l
      `).all({ l: limit });
    } catch (err) {
      log.error({ err: String(err) }, 'getSessionHistory failed');
      return [];
    } finally {
      db.close();
    }
  }
}
