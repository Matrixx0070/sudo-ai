-- ============================================================
-- Wave 4b: sessions table extensions (schema v6)
-- All ALTER TABLE statements must be wrapped in try/catch
-- in the migration runner because SQLite cannot check IF NOT EXISTS
-- for columns.
-- ============================================================

ALTER TABLE sessions ADD COLUMN source_platform   TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_id           TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN system_prompt     TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN input_tokens      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cost_usd          REAL    NOT NULL DEFAULT 0;

-- Index new filter columns
CREATE INDEX IF NOT EXISTS idx_sessions_source_platform   ON sessions(source_platform);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id           ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);

-- ============================================================
-- FTS5 virtual table over messages.content (wave-4b searchSessions)
-- Content-table mirrors messages; rowid = messages.id
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
  content,
  content       = 'messages',
  content_rowid = 'id',
  tokenize      = 'porter unicode61'
);

-- Sync triggers for session_messages_fts

CREATE TRIGGER IF NOT EXISTS smfts_ai
  AFTER INSERT ON messages
  BEGIN
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;

CREATE TRIGGER IF NOT EXISTS smfts_ad
  AFTER DELETE ON messages
  BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
  END;

CREATE TRIGGER IF NOT EXISTS smfts_au
  AFTER UPDATE ON messages
  BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
