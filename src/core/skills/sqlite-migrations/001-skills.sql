-- ============================================================
-- Skills table + session_skills junction table
--
-- skills: append-only, one row per (id, version).
--   same name + different sha256 = new version row
--   archived_at non-null means archived (soft-delete)
--
-- session_skills: junction table tracking which skills are
--   attached to a session. Unique constraint on (session_id, skill_id)
--   ensures one active attach per skill per session.
--   20-skill-per-session cap enforced at application level.
-- ============================================================

CREATE TABLE IF NOT EXISTS skills (
  id              TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  body_md         TEXT NOT NULL DEFAULT '',
  sha256          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  archived_at     TEXT,
  PRIMARY KEY (id, version)
);

-- Fast lookup by name (latest version)
CREATE INDEX IF NOT EXISTS idx_skills_name_version
  ON skills(name, version DESC);

-- Fast lookup of latest per id
CREATE INDEX IF NOT EXISTS idx_skills_id_version
  ON skills(id, version DESC);

-- For scanning: check if (name, sha256) already registered
CREATE INDEX IF NOT EXISTS idx_skills_name_sha256
  ON skills(name, sha256);

CREATE TABLE IF NOT EXISTS session_skills (
  session_id  TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  skill_name  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  attached_at TEXT NOT NULL,
  PRIMARY KEY (session_id, skill_id)
);

-- Fast list for a session
CREATE INDEX IF NOT EXISTS idx_session_skills_session
  ON session_skills(session_id);
