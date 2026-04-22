/**
 * @file registry-sql.ts
 * @description SQL statement strings for SkillRegistry.
 * Extracted to keep registry.ts under 300 lines.
 *
 * Wave 10 extension: added trust_tier + caps_json columns via ALTER TABLE.
 * SQLite has no "IF NOT EXISTS" for ALTER TABLE ADD COLUMN, so we wrap each
 * ALTER in try/catch and swallow "duplicate column name" errors.
 */

/**
 * Apply Wave 10 schema alterations to the skills table.
 * Must be called after the base 001-skills.sql migration runs.
 * Safe to call multiple times — duplicate column errors are swallowed.
 */
export function applyWave10Migrations(db: import('better-sqlite3').Database): void {
  const alters = [
    `ALTER TABLE skills ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'unreviewed'`,
    `ALTER TABLE skills ADD COLUMN caps_json TEXT NOT NULL DEFAULT '[]'`,
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('duplicate column name')) {
        throw err;
      }
      // Column already exists — safe to ignore
    }
  }
}

/**
 * Apply Wave 10 Phase 1 data migration: rename display-string skill names to canonical slugs.
 * Safe to call multiple times — UPDATE WHERE is a no-op when already slugged.
 * Must be called after applyWave10Migrations().
 */
export function applyWave10Phase1NameMigration(db: import('better-sqlite3').Database): void {
  const DISPLAY_TO_SLUG: [string, string][] = [
    ['Web Summary',     'web-summary'],
    ['Cron Health',     'cron-health'],
    ['Self Diagnostic', 'self-diagnostic'],
    ['Daily Brief',     'daily-brief'],
    ['Viral Hook',      'viral-hook'],
  ];

  // Wrap both loops in a single transaction so a failure in session_skills
  // cannot leave the skills table half-migrated.
  // better-sqlite3: db.transaction() rolls back on uncaught throws only;
  // caught exceptions (e.g. "no such table") do NOT trigger rollback.
  const migrate = db.transaction(() => {
    const stmt = db.prepare(`UPDATE skills SET name = ? WHERE name = ?`);
    for (const [display, slug] of DISPLAY_TO_SLUG) {
      stmt.run(slug, display);
    }

    // Also update session_skills.skill_name for any attached sessions
    // (table may not exist in all environments — swallow "no such table" errors)
    try {
      const stmtSS = db.prepare(`UPDATE session_skills SET skill_name = ? WHERE skill_name = ?`);
      for (const [display, slug] of DISPLAY_TO_SLUG) {
        stmtSS.run(slug, display);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('no such table')) {
        throw err;
      }
      // session_skills table absent — safe to skip
    }
  });
  migrate();
}

export const SQL = {
  insert: `
    INSERT INTO skills (id, name, version, frontmatter_json, body_md, sha256, created_at, archived_at, trust_tier, caps_json)
    VALUES (:id, :name, :version, :frontmatter_json, :body_md, :sha256, :created_at, NULL, :trust_tier, :caps_json)
  `,
  getLatestByName:
    `SELECT * FROM skills WHERE name = ? AND archived_at IS NULL ORDER BY version DESC LIMIT 1`,
  getById:
    `SELECT * FROM skills WHERE id = ? ORDER BY version DESC LIMIT 1`,
  getByIdVersion:
    `SELECT * FROM skills WHERE id = ? AND version = ?`,
  getByNameVersion:
    `SELECT * FROM skills WHERE name = ? AND version = ? LIMIT 1`,
  checkHash:
    `SELECT id, version FROM skills WHERE name = ? AND sha256 = ? LIMIT 1`,
  maxVersion:
    `SELECT MAX(version) AS max_ver FROM skills WHERE name = ?`,
  list: `
    SELECT s.id, s.name, s.version, s.frontmatter_json, s.sha256, s.created_at, s.archived_at
    FROM skills s
    INNER JOIN (SELECT name, MAX(version) AS mv FROM skills GROUP BY name) m
      ON s.name = m.name AND s.version = m.mv
    WHERE s.archived_at IS NULL
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `,
  versions: `
    SELECT id, name, version, frontmatter_json, sha256, created_at, archived_at
    FROM skills WHERE name = ? ORDER BY version ASC
  `,
  archive: `
    UPDATE skills SET archived_at = ?
    WHERE name = (SELECT name FROM skills WHERE id = ? LIMIT 1)
  `,
  attachCount:
    `SELECT COUNT(*) AS cnt FROM session_skills WHERE session_id = ?`,
  attach: `
    INSERT OR REPLACE INTO session_skills (session_id, skill_id, skill_name, version, attached_at)
    VALUES (:session_id, :skill_id, :skill_name, :version, :attached_at)
  `,
  detach:
    `DELETE FROM session_skills WHERE session_id = ? AND skill_id = ?`,
  listAttached:
    `SELECT * FROM session_skills WHERE session_id = ? ORDER BY attached_at ASC`,
  getAttachedEntry:
    `SELECT * FROM session_skills WHERE session_id = ? AND skill_id = ?`,
} as const;
