/**
 * @file store.ts
 * @description AgentConfigStore -- versioned agent config persistence via better-sqlite3.
 *
 * Design: append-only, one row per (id, version) in the `agents` table.
 * Create inserts version=1; update and archive each insert a new version row.
 * Security: guardMemoryWrite on `system` field; MemoryInjectionError bubbles unchanged.
 *
 * Dynamic list queries (include_archived variants) live in store-queries.ts.
 * Follows the same patterns as SqliteSessionStore.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { guardMemoryWrite } from '../memory/injection-scanner.js';
import {
  AgentConfigStoreError,
  migrateSchema,
  type AgentConfig,
  type AgentRow,
  type CreateAgentInput,
  type UpdateAgentInput,
  type ListAgentsOptions,
} from './config-types.js';
import { rowToConfig, listAllVersions } from './store-queries.js';

const log = createLogger('agents:store');

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = path.join(__dir, 'sqlite-migrations', '001-agents.sql');

function now(): string { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// AgentConfigStore
// ---------------------------------------------------------------------------

export class AgentConfigStore {
  private readonly db: Database;

  private readonly stmtInsert:       ReturnType<Database['prepare']>;
  private readonly stmtGetLatest:    ReturnType<Database['prepare']>;
  private readonly stmtGetVersion:   ReturnType<Database['prepare']>;
  private readonly stmtListLatest:   ReturnType<Database['prepare']>;
  private readonly stmtListLatestAf: ReturnType<Database['prepare']>;
  private readonly stmtVersions:     ReturnType<Database['prepare']>;

  constructor(db: Database) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
    this._runMigrations();
    migrateSchema(this.db);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO agents
        (id, version, name, model, system_text, tools_json, skills_json,
         mcp_servers_json, created_at, updated_at, archived_at,
         goal, sandbox_policy_json)
      VALUES
        (:id, :version, :name, :model, :system_text, :tools_json, :skills_json,
         :mcp_servers_json, :created_at, :updated_at, :archived_at,
         :goal, :sandbox_policy_json)
    `);

    this.stmtGetLatest = this.db.prepare(
      `SELECT * FROM agents WHERE id = ? ORDER BY version DESC LIMIT 1`,
    );
    this.stmtGetVersion = this.db.prepare(
      `SELECT * FROM agents WHERE id = ? AND version = ?`,
    );
    this.stmtListLatest = this.db.prepare(`
      SELECT a.* FROM agents a
      INNER JOIN (SELECT id, MAX(version) AS max_ver FROM agents GROUP BY id) m
        ON a.id = m.id AND a.version = m.max_ver
      WHERE a.archived_at IS NULL
      ORDER BY a.created_at DESC LIMIT ?
    `);
    this.stmtListLatestAf = this.db.prepare(`
      SELECT a.* FROM agents a
      INNER JOIN (SELECT id, MAX(version) AS max_ver FROM agents GROUP BY id) m
        ON a.id = m.id AND a.version = m.max_ver
      WHERE a.archived_at IS NULL
        AND a.created_at < (SELECT created_at FROM agents WHERE id = ? ORDER BY version ASC LIMIT 1)
      ORDER BY a.created_at DESC LIMIT ?
    `);
    this.stmtVersions = this.db.prepare(
      `SELECT * FROM agents WHERE id = ? ORDER BY version ASC`,
    );
  }

  private _runMigrations(): void {
    try {
      const sql = readFileSync(MIGRATION_SQL, 'utf8');
      this.db.exec(sql);
      log.debug('agents: migration 001-agents.sql applied');
    } catch (err) {
      log.warn({ err: String(err) }, 'agents: migration warning (may already exist)');
    }
  }

  /** Workaround for better-sqlite3 TS types: pass multiple positional args. */
  private _get(stmt: ReturnType<Database['prepare']>, ...args: unknown[]): unknown {
    return (stmt as { get: (...a: unknown[]) => unknown }).get(...args);
  }

  private _all(stmt: ReturnType<Database['prepare']>, ...args: unknown[]): unknown[] {
    return (stmt as { all: (...a: unknown[]) => unknown[] }).all(...args);
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  create(input: CreateAgentInput): AgentConfig {
    const id = genId();
    const ts = now();
    // MemoryInjectionError bubbles unchanged -- do NOT catch
    const safeSystem = input.system
      ? guardMemoryWrite(input.system, 'agent:create:system')
      : null;
    const row: AgentRow = {
      id, version: 1,
      name: input.name, model: input.model, system_text: safeSystem,
      tools_json:       JSON.stringify(input.tools ?? []),
      skills_json:      JSON.stringify(input.skills ?? []),
      mcp_servers_json: JSON.stringify(input.mcp_servers ?? []),
      created_at: ts, updated_at: ts, archived_at: null,
      goal: input.goal ?? null,
      sandbox_policy_json: input.sandbox_policy != null
        ? JSON.stringify(input.sandbox_policy)
        : null,
    };
    this.stmtInsert.run(row);
    log.info({ id, name: input.name }, 'agent created');
    return rowToConfig(row);
  }

  // ---------------------------------------------------------------------------
  // Get (latest or specific version)
  // ---------------------------------------------------------------------------

  get(id: string, version?: number): AgentConfig | undefined {
    if (!id) return undefined;
    const row = version !== undefined
      ? this._get(this.stmtGetVersion, id, version) as AgentRow | undefined
      : this.stmtGetLatest.get(id) as AgentRow | undefined;
    return row ? rowToConfig(row) : undefined;
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  list(options: ListAgentsOptions = {}): AgentConfig[] {
    const limit = Math.min(options.limit ?? 50, 100);

    if (options.include_archived) {
      return listAllVersions(this.db, limit, options.after_id);
    }

    const rows: AgentRow[] = options.after_id
      ? this._all(this.stmtListLatestAf, options.after_id, limit) as AgentRow[]
      : this.stmtListLatest.all(limit) as AgentRow[];

    return rows.map(rowToConfig);
  }

  // ---------------------------------------------------------------------------
  // Update (optimistic lock)
  // ---------------------------------------------------------------------------

  update(id: string, input: UpdateAgentInput): AgentConfig {
    const current = this.get(id);
    if (!current) throw new AgentConfigStoreError(`Agent not found: ${id}`, 'agent_not_found', { id });
    if (current.archived_at !== null) {
      throw new AgentConfigStoreError(`Agent ${id} is archived`, 'agent_archived', { id });
    }
    if (current.version !== input.version) {
      throw new AgentConfigStoreError(
        `Optimistic lock conflict: expected version ${current.version}, got ${input.version}`,
        'agent_version_conflict',
        { id, expected: current.version, received: input.version },
      );
    }
    const safeSystem = input.system !== undefined
      ? (input.system ? guardMemoryWrite(input.system, 'agent:update:system') : null)
      : current.system;
    const nextVersion = current.version + 1;
    const ts = now();
    const row: AgentRow = {
      id, version: nextVersion,
      name:             input.name        ?? current.name,
      model:            input.model       ?? current.model,
      system_text:      safeSystem,
      tools_json:       input.tools        !== undefined ? JSON.stringify(input.tools)        : JSON.stringify(current.tools),
      skills_json:      input.skills       !== undefined ? JSON.stringify(input.skills)       : JSON.stringify(current.skills),
      mcp_servers_json: input.mcp_servers  !== undefined ? JSON.stringify(input.mcp_servers)  : JSON.stringify(current.mcp_servers),
      created_at: current.created_at, updated_at: ts, archived_at: null,
      goal: input.goal !== undefined ? (input.goal ?? null) : (current.goal ?? null),
      sandbox_policy_json: input.sandbox_policy !== undefined
        ? (input.sandbox_policy != null ? JSON.stringify(input.sandbox_policy) : null)
        : (current.sandbox_policy != null ? JSON.stringify(current.sandbox_policy) : null),
    };
    this.stmtInsert.run(row);
    log.info({ id, version: nextVersion }, 'agent updated');
    return rowToConfig(row);
  }

  // ---------------------------------------------------------------------------
  // Archive
  // ---------------------------------------------------------------------------

  archive(id: string): AgentConfig {
    const current = this.get(id);
    if (!current) throw new AgentConfigStoreError(`Agent not found: ${id}`, 'agent_not_found', { id });
    if (current.archived_at !== null) return current; // idempotent
    const ts = now();
    const nextVersion = current.version + 1;
    const row: AgentRow = {
      id, version: nextVersion,
      name: current.name, model: current.model, system_text: current.system,
      tools_json:       JSON.stringify(current.tools),
      skills_json:      JSON.stringify(current.skills),
      mcp_servers_json: JSON.stringify(current.mcp_servers),
      created_at: current.created_at, updated_at: ts, archived_at: ts,
      goal: current.goal ?? null,
      sandbox_policy_json: current.sandbox_policy != null
        ? JSON.stringify(current.sandbox_policy)
        : null,
    };
    this.stmtInsert.run(row);
    log.info({ id, version: nextVersion }, 'agent archived');
    return rowToConfig(row);
  }

  // ---------------------------------------------------------------------------
  // Version history
  // ---------------------------------------------------------------------------

  versions(id: string): AgentConfig[] {
    return (this.stmtVersions.all(id) as AgentRow[]).map(rowToConfig);
  }
}
