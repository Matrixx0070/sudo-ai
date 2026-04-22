/**
 * versioning-io.ts — DDL, types, and row-mapping helpers for SkillVersioning.
 * Separated to keep versioning.ts under the 300-line module limit.
 */

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const SKILL_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS skill_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name       TEXT    NOT NULL,
  version          TEXT    NOT NULL,
  source_code      TEXT    NOT NULL,
  changelog        TEXT    DEFAULT '',
  executions       INTEGER DEFAULT 0,
  successes        INTEGER DEFAULT 0,
  failures         INTEGER DEFAULT 0,
  avg_latency_ms   REAL    DEFAULT 0,
  active           INTEGER DEFAULT 0,
  created_at       TEXT    NOT NULL
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(skill_name, version)
);
CREATE INDEX IF NOT EXISTS idx_sv_name   ON skill_versions(skill_name);
CREATE INDEX IF NOT EXISTS idx_sv_active ON skill_versions(active);
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillVersion {
  id: number;
  skillName: string;
  version: string;
  sourceCode: string;
  changelog: string;
  performance: {
    executions: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
  };
  createdAt: string;
  active: boolean;
}

export interface SkillDiff {
  added: string[];
  removed: string[];
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

export interface VersionRow {
  id: number;
  skill_name: string;
  version: string;
  source_code: string;
  changelog: string;
  executions: number;
  successes: number;
  failures: number;
  avg_latency_ms: number;
  active: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function rowToVersion(row: VersionRow): SkillVersion {
  return {
    id: row.id,
    skillName: row.skill_name,
    version: row.version,
    sourceCode: row.source_code,
    changelog: row.changelog ?? '',
    performance: {
      executions: row.executions,
      successes: row.successes,
      failures: row.failures,
      avgLatencyMs: row.avg_latency_ms,
    },
    createdAt: row.created_at,
    active: row.active === 1,
  };
}

export function validateSkillName(name: string): void {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('skillName must be a non-empty string');
  }
}

export function validateSourceCode(code: string): void {
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new Error('sourceCode must be a non-empty string');
  }
}

export function validateSemver(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be semver (e.g. "1.0.0"): got "${version}"`);
  }
}
