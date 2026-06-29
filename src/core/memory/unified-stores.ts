/**
 * @file unified-stores.ts
 * @description Raw SQL helpers for UnifiedMemory.
 *
 * Each function accepts an already-open readonly Database and returns
 * MemoryResult rows for one logical store.  Callers (unified.ts) are
 * responsible for opening, closing, and error-wrapping the connections.
 *
 * This module is internal — import from unified.ts, not here directly.
 */

import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { MemoryResult } from './unified.js';

// ---------------------------------------------------------------------------
// Scoring helper (shared by all store queries)
// ---------------------------------------------------------------------------

export function scoreContent(content: string, query: string): number {
  const lc     = content.toLowerCase();
  const lq     = query.toLowerCase();
  const tokens = lq.split(/\s+/).filter(Boolean);
  if (lc === lq)         return 1;
  if (lc.includes(lq))  return 0.9;
  const hits = tokens.filter(t => lc.includes(t)).length;
  return hits > 0 ? 0.5 + (hits / tokens.length) * 0.1 : 0;
}

// ---------------------------------------------------------------------------
// mind.db — chunks + messages
// ---------------------------------------------------------------------------

export function queryMindChunks(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { text: string; path: string; source: string; created_at: string }>(
    // superseded_by IS NULL: don't resurface a fact retired by contradiction
    // resolution (hybrid-search already excludes these; this path didn't) (RAG-4).
    `SELECT text, path, source, created_at FROM chunks WHERE text LIKE :p AND superseded_by IS NULL LIMIT 30`,
  ).all({ p: pattern });

  return rows.map(row => ({
    content:   row.text,
    source:    'mind' as const,
    table:     'chunks',
    relevance: scoreContent(row.text, q),
    timestamp: row.created_at,
    metadata:  { path: row.path, subSource: row.source },
  }));
}

export function queryMindMessages(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { content: string; role: string; created_at: string; session_id: string }>(
    `SELECT content, role, created_at, session_id FROM messages WHERE content LIKE :p LIMIT 20`,
  ).all({ p: pattern });

  return rows.map(row => ({
    content:   row.content,
    source:    'mind' as const,
    table:     'messages',
    relevance: scoreContent(row.content, q),
    timestamp: row.created_at,
    metadata:  { role: row.role, session_id: row.session_id },
  }));
}

export function queryMindTasks(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { title: string; description: string | null; status: string; created_at: string }>(
    `SELECT title, description, status, created_at FROM tasks WHERE title LIKE :p OR description LIKE :p LIMIT 15`,
  ).all({ p: pattern });

  return rows.map(row => {
    const content = `[${row.status}] ${row.title}${row.description ? ': ' + row.description : ''}`;
    return {
      content,
      source:    'tasks' as const,
      table:     'tasks',
      relevance: scoreContent(content, q),
      timestamp: row.created_at,
      metadata:  { status: row.status },
    };
  });
}

// ---------------------------------------------------------------------------
// consciousness.db — thoughts + episodes
// ---------------------------------------------------------------------------

export function queryThoughts(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { content: string; tier: string; created_at: string }>(
    `SELECT content, tier, created_at FROM thoughts WHERE content LIKE :p LIMIT 20`,
  ).all({ p: pattern });

  return rows.map(row => ({
    content:   row.content,
    source:    'consciousness' as const,
    table:     'thoughts',
    relevance: scoreContent(row.content, q),
    timestamp: row.created_at,
    metadata:  { tier: row.tier },
  }));
}

export function queryEpisodes(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { summary: string; topic: string; outcome: string; created_at: string }>(
    `SELECT summary, topic, outcome, created_at FROM episodes WHERE summary LIKE :p OR topic LIKE :p LIMIT 15`,
  ).all({ p: pattern });

  return rows.map(row => ({
    content:   row.summary,
    source:    'consciousness' as const,
    table:     'episodes',
    relevance: scoreContent(row.summary, q),
    timestamp: row.created_at,
    metadata:  { topic: row.topic, outcome: row.outcome },
  }));
}

// ---------------------------------------------------------------------------
// knowledge.db — kg_nodes
// ---------------------------------------------------------------------------

export function queryKgNodes(db: Database.Database, pattern: string, q: string): MemoryResult[] {
  const rows = db.prepare<{ p: string }, { title: string; content: string; type: string; created_at: string }>(
    `SELECT title, content, type, created_at FROM kg_nodes WHERE title LIKE :p OR content LIKE :p LIMIT 20`,
  ).all({ p: pattern });

  return rows.map(row => {
    const combined = `${row.title}: ${row.content}`;
    return {
      content:   combined,
      source:    'knowledge' as const,
      table:     'kg_nodes',
      relevance: scoreContent(combined, q),
      timestamp: row.created_at,
      metadata:  { type: row.type },
    };
  });
}

// ---------------------------------------------------------------------------
// workspace files
// ---------------------------------------------------------------------------

export function searchWorkspaceFiles(files: string[], query: string): MemoryResult[] {
  const results: MemoryResult[] = [];
  const lq = query.toLowerCase();

  for (const filePath of files) {
    if (!['.md', '.txt', '.json'].includes(extname(filePath))) continue;
    try {
      const stat = statSync(filePath);
      if (stat.size > 500_000) continue;

      const content = readFileSync(filePath, 'utf8');
      if (!content.toLowerCase().includes(lq)) continue;

      const lines = content.split('\n');
      const matchLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && line.toLowerCase().includes(lq)) {
          matchLines.push([lines[i - 1] ?? '', line, lines[i + 1] ?? ''].filter(Boolean).join('\n'));
          if (matchLines.length >= 3) break;
        }
      }

      if (matchLines.length > 0) {
        results.push({
          content:   matchLines.join('\n---\n').slice(0, 800),
          source:    'workspace' as const,
          relevance: scoreContent(content, query),
          timestamp: stat.mtime.toISOString(),
          metadata:  { file: filePath },
        });
      }
    } catch { /* skip unreadable files */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// count helper
// ---------------------------------------------------------------------------

/** Allowlisted table names for countTable — prevents SQL injection via table parameter. */
const ALLOWED_COUNT_TABLES = new Set([
  'sessions', 'messages', 'thoughts', 'concept_nodes',
  'episodes', 'skills', 'error_memory', 'chunks',
]);

export function countTable(db: Database.Database, table: string): number {
  if (!ALLOWED_COUNT_TABLES.has(table)) {
    throw new Error(`countTable: table "${table}" is not in the allowed list`);
  }
  try {
    const row = db.prepare<Record<string, never>, { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get({});
    return row?.n ?? 0;
  } catch { return 0; }
}
