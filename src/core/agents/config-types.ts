/**
 * @file config-types.ts
 * @description Type definitions for the versioned agent config REST resource.
 *
 * Mirrors the Anthropic Managed Agents /v1/agents API surface.
 * Named config-types.ts to avoid collision with the existing orchestration types.ts.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { SudoError } from '../shared/errors.js';

const log = createLogger('agents:config-types');

// ---------------------------------------------------------------------------
// AgentConfig — public API shape returned by all endpoints
// ---------------------------------------------------------------------------

/** A single tool definition (free-form object matching Anthropic's schema). */
export type ToolDefinition = Record<string, unknown>;

/** A single skill reference. */
export type SkillRef = Record<string, unknown>;

/** An MCP server reference. */
export type McpServerRef = Record<string, unknown>;

/**
 * Full agent configuration resource.
 * `id` is stable across versions; `version` starts at 1 and increments on each update.
 */
export interface AgentConfig {
  id:             string;
  name:           string;
  model:          string;
  system:         string | null;
  tools:          ToolDefinition[];
  skills:         SkillRef[];
  mcp_servers:    McpServerRef[];
  version:        number;
  created_at:     string;   // ISO-8601 — set on first create, never changes
  updated_at:     string;   // ISO-8601 — updated on every version bump
  archived_at:    string | null;
  /** Optional free-text goal for this agent configuration. */
  goal?:          string | null;
  /**
   * Sandbox policy override for this agent.
   * Stored as Record to avoid cross-builder compile dependency on sandbox-types.ts.
   * Integrator casts to SandboxPolicy when wiring.
   */
  sandbox_policy?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Input shapes for create / update
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  name:            string;
  model:           string;
  system?:         string | null;
  tools?:          ToolDefinition[];
  skills?:         SkillRef[];
  mcp_servers?:    McpServerRef[];
  goal?:           string | null;
  sandbox_policy?: Record<string, unknown> | null;
}

export interface UpdateAgentInput {
  /** Client must supply the current version for optimistic locking. */
  version:         number;
  name?:           string;
  model?:          string;
  system?:         string | null;
  tools?:          ToolDefinition[];
  skills?:         SkillRef[];
  mcp_servers?:    McpServerRef[];
  goal?:           string | null;
  sandbox_policy?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Pagination options
// ---------------------------------------------------------------------------

export interface ListAgentsOptions {
  limit?:            number;   // default 50, max 100
  after_id?:         string;   // cursor: last seen agent id (created_at ordering)
  include_archived?: boolean;
}

// ---------------------------------------------------------------------------
// Raw SQLite row shape (append-only, one row per version)
// ---------------------------------------------------------------------------

/** Raw row as returned by better-sqlite3 (column names map to SQL schema). */
export interface AgentRow {
  id:                   string;
  version:              number;
  name:                 string;
  model:                string;
  system_text:          string | null;
  tools_json:           string;
  skills_json:          string;
  mcp_servers_json:     string;
  created_at:           string;
  updated_at:           string;
  archived_at:          string | null;
  /** Nullable goal text for this agent version. */
  goal:                 string | null;
  /** Sandbox policy serialized as JSON string. NULL = use default policy. */
  sandbox_policy_json:  string | null;
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

/**
 * Additive schema migration for agents and sessions tables.
 *
 * Adds the goal and sandbox_policy_json columns to agents,
 * and goal and outcome_json columns to sessions.
 *
 * Each ALTER TABLE is wrapped in its own try/catch so that
 * pre-existing columns are silently ignored (SQLite raises on duplicate ADD).
 * This function is idempotent and safe to call multiple times.
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function migrateSchema(db: Database): void {
  const alters = [
    'ALTER TABLE agents ADD COLUMN goal TEXT',
    'ALTER TABLE agents ADD COLUMN sandbox_policy_json TEXT',
    'ALTER TABLE sessions ADD COLUMN goal TEXT',
    'ALTER TABLE sessions ADD COLUMN outcome_json TEXT',
  ] as const;

  for (const sql of alters) {
    try {
      db.exec(sql);
      log.debug({ sql }, 'migrateSchema: ALTER TABLE applied');
    } catch (err: unknown) {
      // Only silence "duplicate column" errors — these are expected on re-runs.
      // All other errors (disk-full, SQLITE_BUSY, read-only FS, etc.) must
      // propagate so the process fails fast at boot rather than hiding corruption.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('already has a column named') ||
        msg.includes('duplicate column name') ||
        msg.includes('no such table')
      ) {
        // Benign migration conditions: column already exists, or table not yet
        // created (startup ordering). Neither indicates data corruption.
        log.debug({ sql }, 'migrateSchema: column already exists or table absent, skipping');
      } else {
        // Unexpected errors (disk-full, SQLITE_BUSY, read-only FS, etc.) must
        // propagate so the process fails fast at boot rather than hiding corruption.
        log.error({ err, sql }, 'migrateSchema: unexpected error');
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class AgentConfigStoreError extends SudoError {
  constructor(
    message: string,
    code: `agent_${string}`,
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
    (this as unknown as { name: string }).name = 'AgentConfigStoreError';
  }
}
