/**
 * @file kg-schema.ts
 * @description SQLite schema SQL and raw row type definitions for KnowledgeGraph.
 * Kept separate to stay within the 250-line file limit.
 */

import Database from 'better-sqlite3';
import type { KnowledgeNode, KnowledgeEdge } from './types.js';

// ---------------------------------------------------------------------------
// Raw DB row types (better-sqlite3 returns plain objects)
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: number;
  type: KnowledgeNode['type'];
  title: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
  valid_at: string | null;
  expired_at: string | null;
}

export interface EdgeRow {
  id: number;
  from_id: number;
  to_id: number;
  relation: string;
  weight: number;
  properties: string;
  valid_at: string | null;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kg_nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL DEFAULT 'note',
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    tags       TEXT    NOT NULL DEFAULT '[]',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    valid_at   TEXT,
    expired_at TEXT
  );

  CREATE TABLE IF NOT EXISTS kg_edges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation   TEXT    NOT NULL DEFAULT 'relates-to',
    weight     REAL    NOT NULL DEFAULT 1.0,
    properties TEXT    NOT NULL DEFAULT '{}',
    valid_at   TEXT,
    UNIQUE(from_id, to_id, relation)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
    title,
    content,
    content='kg_nodes',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS kg_nodes_ai AFTER INSERT ON kg_nodes BEGIN
    INSERT INTO kg_nodes_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_nodes_au AFTER UPDATE ON kg_nodes BEGIN
    INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO kg_nodes_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_nodes_ad AFTER DELETE ON kg_nodes BEGIN
    INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
  END;
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

export function rowToNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validAt: row.valid_at ?? null,
    expiredAt: row.expired_at ?? null,
  };
}

export function rowToEdge(row: EdgeRow): KnowledgeEdge {
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties ?? '{}') as Record<string, unknown>;
  } catch { /* ignore — fall back to empty object */ }
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    weight: row.weight,
    properties,
    validAt: row.valid_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Temporal migration
// ---------------------------------------------------------------------------

/**
 * Idempotently add temporal columns to existing kg_nodes and kg_edges tables.
 * Safe to call on both new (already-migrated) and legacy databases.
 */
export function migrateTemporalColumns(db: Database.Database): void {
  const nodeColumns = db.pragma('table_info(kg_nodes)') as Array<{ name: string }>;
  const nodeColNames = nodeColumns.map((c) => c.name);
  if (!nodeColNames.includes('valid_at')) {
    db.exec(`ALTER TABLE kg_nodes ADD COLUMN valid_at TEXT`);
  }
  if (!nodeColNames.includes('expired_at')) {
    db.exec(`ALTER TABLE kg_nodes ADD COLUMN expired_at TEXT`);
  }
  const edgeColumns = db.pragma('table_info(kg_edges)') as Array<{ name: string }>;
  const edgeColNames = edgeColumns.map((c) => c.name);
  if (!edgeColNames.includes('properties')) {
    db.exec(`ALTER TABLE kg_edges ADD COLUMN properties TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!edgeColNames.includes('valid_at')) {
    db.exec(`ALTER TABLE kg_edges ADD COLUMN valid_at TEXT`);
  }
}
