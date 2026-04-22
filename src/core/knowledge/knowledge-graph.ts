/**
 * @file knowledge-graph.ts
 * @description KnowledgeGraph — SQLite-backed directed graph for knowledge
 * storage. Uses better-sqlite3 (synchronous) and FTS5 for full-text search.
 *
 * Tables:
 *   kg_nodes (id, type, title, content, tags JSON, created_at, updated_at)
 *   kg_edges (id, from_id, to_id, relation, weight)
 *   kg_nodes_fts (FTS5 virtual table over title + content)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { KnowledgeNode, KnowledgeEdge } from './types.js';
import { SCHEMA_SQL, rowToNode, rowToEdge, migrateTemporalColumns } from './kg-schema.js';
import type { NodeRow, EdgeRow } from './kg-schema.js';

const log = createLogger('knowledge-graph');

// ---------------------------------------------------------------------------
// KnowledgeGraph
// ---------------------------------------------------------------------------

export class KnowledgeGraph {
  private readonly db: Database.Database;

  constructor(dbPath = 'data/knowledge.db') {
    const absPath = resolve(dbPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(absPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    migrateTemporalColumns(this.db);
    log.info({ dbPath: absPath }, 'KnowledgeGraph ready');
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  addNode(
    type: KnowledgeNode['type'],
    title: string,
    content: string,
    tags: string[] = [],
  ): KnowledgeNode {
    if (!title.trim()) throw new Error('KnowledgeGraph.addNode: title must not be empty');

    const info = this.db.prepare(`
      INSERT INTO kg_nodes (type, title, content, tags)
      VALUES (:type, :title, :content, :tags)
    `).run({ type, title, content, tags: JSON.stringify(tags) });

    const id = info.lastInsertRowid as number;
    log.info({ id, type, title }, 'Node added');
    return this._getNodeOrThrow(id);
  }

  getNode(id: number): KnowledgeNode | undefined {
    const row = this.db
      .prepare<{ id: number }, NodeRow>('SELECT * FROM kg_nodes WHERE id = :id')
      .get({ id });
    return row ? rowToNode(row) : undefined;
  }

  deleteNode(id: number): boolean {
    const info = this.db
      .prepare<{ id: number }>('DELETE FROM kg_nodes WHERE id = :id')
      .run({ id });
    return info.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  addEdge(fromId: number, toId: number, relation = 'relates-to', weight = 1.0): KnowledgeEdge {
    const info = this.db.prepare(`
      INSERT OR REPLACE INTO kg_edges (from_id, to_id, relation, weight)
      VALUES (:from_id, :to_id, :relation, :weight)
    `).run({ from_id: fromId, to_id: toId, relation, weight });

    const id = info.lastInsertRowid as number;
    const row = this.db
      .prepare<{ id: number }, EdgeRow>('SELECT * FROM kg_edges WHERE id = :id')
      .get({ id });
    log.info({ id, fromId, toId, relation }, 'Edge added');
    return rowToEdge(row!);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /** Full-text search using FTS5. Returns up to `limit` nodes. */
  findNodes(query: string, limit = 20): KnowledgeNode[] {
    // Sanitize FTS query to prevent injection via special FTS5 operators.
    const sanitized = query
      .replace(/[*"()]/g, '')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
      .trim();
    if (!sanitized) return [];

    const rows = this.db.prepare<{ query: string; limit: number }, NodeRow>(`
      SELECT n.* FROM kg_nodes n
      JOIN kg_nodes_fts f ON f.rowid = n.id
      WHERE kg_nodes_fts MATCH :query
      ORDER BY rank
      LIMIT :limit
    `).all({ query: sanitized, limit });
    return rows.map(rowToNode);
  }

  /**
   * Return nodes that are valid as of the given timestamp.
   * A node is valid when:
   *   (valid_at IS NULL OR valid_at <= asOf) AND (expired_at IS NULL OR expired_at > asOf)
   * If query is provided, also filter by FTS match.
   *
   * @param query - Optional FTS query string.
   * @param asOf  - ISO-8601 reference timestamp (defaults to now).
   */
  getValidNodes(query?: string, asOf?: string): KnowledgeNode[] {
    const ref = asOf ?? new Date().toISOString();

    if (query) {
      const sanitized = query
        .replace(/[*"()]/g, '')
        .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
        .trim();
      if (!sanitized) return this.getValidNodes(undefined, ref);

      const rows = this.db.prepare<{ query: string; ref: string }, NodeRow>(`
        SELECT n.* FROM kg_nodes n
        JOIN kg_nodes_fts f ON f.rowid = n.id
        WHERE kg_nodes_fts MATCH :query
          AND (n.valid_at IS NULL OR n.valid_at <= :ref)
          AND (n.expired_at IS NULL OR n.expired_at > :ref)
        ORDER BY rank
      `).all({ query: sanitized, ref });
      return rows.map(rowToNode);
    }

    const rows = this.db.prepare<{ ref: string }, NodeRow>(`
      SELECT * FROM kg_nodes
      WHERE (valid_at IS NULL OR valid_at <= :ref)
        AND (expired_at IS NULL OR expired_at > :ref)
      ORDER BY updated_at DESC
    `).all({ ref });
    return rows.map(rowToNode);
  }

  /** BFS traversal up to maxDepth hops from a starting node. */
  getNeighbors(nodeId: number, maxDepth = 2): KnowledgeNode[] {
    const visited = new Set<number>([nodeId]);
    const queue: Array<{ id: number; depth: number }> = [{ id: nodeId, depth: 0 }];
    const result: KnowledgeNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const edges = this.db.prepare<{ id: number }, EdgeRow>(`
        SELECT * FROM kg_edges WHERE from_id = :id OR to_id = :id
      `).all({ id: current.id });

      for (const edge of edges) {
        const neighborId = edge.from_id === current.id ? edge.to_id : edge.from_id;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const node = this.getNode(neighborId);
        if (node) {
          result.push(node);
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
      }
    }
    return result;
  }

  /** Find shortest path between two nodes using BFS. Returns node IDs or null. */
  findPath(fromId: number, toId: number, maxDepth = 6): number[] | null {
    if (fromId === toId) return [fromId];

    const parent = new Map<number, number>();
    const queue: Array<{ id: number; depth: number }> = [{ id: fromId, depth: 0 }];
    parent.set(fromId, -1);

    while (queue.length > 0) {
      const { id: current, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;;
      const edges = this.db.prepare<{ id: number }, EdgeRow>(`
        SELECT * FROM kg_edges WHERE from_id = :id OR to_id = :id
      `).all({ id: current });

      for (const edge of edges) {
        const neighbor = edge.from_id === current ? edge.to_id : edge.from_id;
        if (parent.has(neighbor)) continue;
        parent.set(neighbor, current);
        if (neighbor === toId) {
          const path: number[] = [];
          let cur: number | undefined = toId;
          while (cur !== undefined && cur !== -1) {
            path.unshift(cur);
            cur = parent.get(cur);
          }
          return path;
        }
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
    return null;
  }

  /**
   * Return node pairs connected by 'contradicts' edges.
   */
  getContradictions(): Array<{ from: KnowledgeNode; to: KnowledgeNode; relation: string }> {
    const edges = this.db.prepare<Record<string, never>, EdgeRow>(`
      SELECT * FROM kg_edges WHERE relation = 'contradicts'
    `).all({});

    return edges.flatMap((edge) => {
      const from = this.getNode(edge.from_id);
      const to = this.getNode(edge.to_id);
      if (!from || !to) return [];
      return [{ from, to, relation: edge.relation }];
    });
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _getNodeOrThrow(id: number): KnowledgeNode {
    const row = this.db
      .prepare<{ id: number }, NodeRow>('SELECT * FROM kg_nodes WHERE id = :id')
      .get({ id });
    if (!row) throw new Error(`KnowledgeGraph: node ${id} not found after insert`);
    return rowToNode(row);
  }
}
