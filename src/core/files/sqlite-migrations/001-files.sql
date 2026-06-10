-- Files API table
-- All file metadata persisted here; actual bytes live on disk at storage_path.

CREATE TABLE IF NOT EXISTS files (
  id           TEXT    NOT NULL PRIMARY KEY,         -- file_<nanoid>
  filename     TEXT    NOT NULL,                     -- basename only, path-traversal sanitised
  mime         TEXT    NOT NULL,                     -- declared MIME type
  size_bytes   INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256       TEXT    NOT NULL,                     -- hex SHA-256 of raw bytes
  scope_id     TEXT    NOT NULL,                     -- session_id that uploaded this file
  storage_path TEXT    NOT NULL,                     -- absolute path on disk
  uploaded_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT    DEFAULT NULL                  -- soft-delete timestamp (NULL = active)
);

CREATE INDEX IF NOT EXISTS idx_files_scope_id   ON files(scope_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_sha256     ON files(sha256)   WHERE deleted_at IS NULL;
