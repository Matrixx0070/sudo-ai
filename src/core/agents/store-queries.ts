/**
 * @file store-queries.ts
 * @description Dynamic query builders for AgentConfigStore list operations.
 *
 * Separated from store.ts to keep individual files under 300 lines.
 * These are ad-hoc queries that cannot be pre-compiled as prepared statements
 * because they vary by the include_archived flag and presence of cursor.
 */

import type { Database } from 'better-sqlite3';
import type { AgentConfig, AgentRow } from './config-types.js';

/** Row-to-config deserializer (shared with store.ts via import). */
export function rowToConfig(row: AgentRow): AgentConfig {
  return {
    id:          row.id,
    name:        row.name,
    model:       row.model,
    system:      row.system_text,
    tools:       JSON.parse(row.tools_json) as AgentConfig['tools'],
    skills:      JSON.parse(row.skills_json) as AgentConfig['skills'],
    mcp_servers: JSON.parse(row.mcp_servers_json) as AgentConfig['mcp_servers'],
    version:     row.version,
    created_at:  row.created_at,
    updated_at:  row.updated_at,
    archived_at: row.archived_at,
    goal:        row.goal ?? null,
    sandbox_policy: row.sandbox_policy_json != null
      ? (JSON.parse(row.sandbox_policy_json) as Record<string, unknown>)
      : null,
  };
}

/**
 * Query all latest-version rows (including archived) for the list endpoint.
 * Uses ad-hoc statements since the filter set varies.
 */
export function listAllVersions(
  db: Database,
  limit: number,
  afterId?: string,
): AgentConfig[] {
  let rows: AgentRow[];
  if (afterId) {
    const stmt = db.prepare(`
      SELECT a.* FROM agents a
      INNER JOIN (
        SELECT id, MAX(version) AS max_ver FROM agents GROUP BY id
      ) m ON a.id = m.id AND a.version = m.max_ver
      WHERE a.created_at < (
        SELECT created_at FROM agents WHERE id = ? ORDER BY version ASC LIMIT 1
      )
      ORDER BY a.created_at DESC
      LIMIT ?
    `);
    rows = (stmt as { all: (...a: unknown[]) => unknown[] }).all(afterId, limit) as AgentRow[];
  } else {
    const stmt = db.prepare(`
      SELECT a.* FROM agents a
      INNER JOIN (
        SELECT id, MAX(version) AS max_ver FROM agents GROUP BY id
      ) m ON a.id = m.id AND a.version = m.max_ver
      ORDER BY a.created_at DESC
      LIMIT ?
    `);
    rows = stmt.all(limit) as AgentRow[];
  }
  return rows.map(rowToConfig);
}
