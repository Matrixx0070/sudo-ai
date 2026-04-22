-- ============================================================
-- Wave 5: agents table — versioned agent configuration store
--
-- Design: append-only, one row per (id, version).
-- PRIMARY KEY is (id, version) so each version is a distinct row.
-- created_at is stable (set on first insert, never changes per agent).
-- updated_at reflects when this specific version row was written.
-- archived_at null means active; non-null means archived at that timestamp.
-- tools_json, skills_json, mcp_servers_json store JSON arrays.
-- system_text avoids using the SQL reserved word `system` as a column name.
-- ============================================================

CREATE TABLE IF NOT EXISTS agents (
  id               TEXT NOT NULL,
  version          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  model            TEXT NOT NULL,
  system_text      TEXT,
  tools_json       TEXT NOT NULL DEFAULT '[]',
  skills_json      TEXT NOT NULL DEFAULT '[]',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT,
  PRIMARY KEY (id, version)
);

-- Index for fast latest-version lookup per agent
CREATE INDEX IF NOT EXISTS idx_agents_id_version
  ON agents(id, version DESC);

-- Index for list endpoint ordering (newest agent first by first version's created_at)
CREATE INDEX IF NOT EXISTS idx_agents_created_at
  ON agents(created_at DESC);
