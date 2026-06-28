/**
 * @file consciousness-db.ts
 * @description SQLite database wrapper for the SUDO-AI v4 consciousness layer.
 *
 * Creates and manages `data/consciousness.db` (or a path override for testing).
 * Applies WAL mode, synchronous=NORMAL, and foreign-key enforcement.
 * Schema is initialised idempotently via IF NOT EXISTS guards.
 *
 * Uses better-sqlite3 synchronous API throughout — no async/await.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import { ConsciousnessError } from './errors.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness-db');

// ---------------------------------------------------------------------------
// Default database path
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = dataPath('consciousness.db');

// ---------------------------------------------------------------------------
// Schema — one complete SQL statement per array element
// Trigger bodies contain internal semicolons inside BEGIN...END, so we use an
// array rather than a single exec() string to avoid naive semicolon-split bugs.
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS: readonly string[] = [

  // ==========================================================================
  // body_state_log
  // Periodic snapshots of the AI's simulated somatic state.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS body_state_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    energy        REAL    NOT NULL CHECK (energy        BETWEEN 0 AND 1),
    clarity       REAL    NOT NULL CHECK (clarity       BETWEEN 0 AND 1),
    fullness      REAL    NOT NULL CHECK (fullness      BETWEEN 0 AND 1),
    connectivity  REAL    NOT NULL CHECK (connectivity  BETWEEN 0 AND 1),
    continuity    REAL    NOT NULL CHECK (continuity    BETWEEN 0 AND 1),
    -- JSON bag for any additional raw metrics not captured by the five core fields
    raw_metrics   TEXT    NOT NULL,
    sampled_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_body_state_sampled_at
    ON body_state_log(sampled_at)`,

  // ==========================================================================
  // concept_nodes
  // Nodes in the spreading-activation associative network.
  // Activation decays over time; last_activated drives temporal decay logic.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS concept_nodes (
    id                 TEXT    PRIMARY KEY,
    activation         REAL    NOT NULL DEFAULT 0
                         CHECK (activation BETWEEN 0 AND 1),
    last_activated     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    total_activations  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // concept_edges
  // Weighted directed edges between concept nodes.
  // UNIQUE(from_id, to_id) prevents duplicate edges — use UPSERT to update.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS concept_edges (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id       TEXT    NOT NULL REFERENCES concept_nodes(id),
    to_id         TEXT    NOT NULL REFERENCES concept_nodes(id),
    weight        REAL    NOT NULL DEFAULT 0.5
                    CHECK (weight BETWEEN 0 AND 1),
    cooccurrences INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(from_id, to_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_concept_edges_from
    ON concept_edges(from_id)`,

  `CREATE INDEX IF NOT EXISTS idx_concept_edges_to
    ON concept_edges(to_id)`,

  `CREATE TRIGGER IF NOT EXISTS concept_edges_updated_at
    AFTER UPDATE ON concept_edges
    FOR EACH ROW
    BEGIN
      UPDATE concept_edges
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // emotional_state_log
  // Time-series log of emotional valence readings.
  // `valence` stores the serialised EmotionalValence as JSON.
  // `source` is a free-form label e.g. 'user_interaction', 'internal_appraisal'.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS emotional_state_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    valence    TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_emotional_state_created_at
    ON emotional_state_log(created_at)`,

  // ==========================================================================
  // somatic_markers
  // Learned trigger→emotion associations (Damasio somatic marker hypothesis).
  // trigger_pattern is a plain-text or regex-like descriptor matched at runtime.
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS somatic_markers (
    id                   TEXT    PRIMARY KEY,
    trigger_pattern      TEXT    NOT NULL,
    emotion              TEXT    NOT NULL,
    intensity            REAL    NOT NULL CHECK (intensity BETWEEN 0 AND 1),
    -- Optional back-reference to the episodic memory that created this marker
    associated_episode_id TEXT,
    times_triggered      INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_somatic_trigger
    ON somatic_markers(trigger_pattern)`,

  `CREATE TRIGGER IF NOT EXISTS somatic_markers_updated_at
    AFTER UPDATE ON somatic_markers
    FOR EACH ROW
    BEGIN
      UPDATE somatic_markers
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = OLD.id;
    END`,

  // ==========================================================================
  // WAVE 2: thoughts (cognitive-stream)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS thoughts (
    id                 TEXT    PRIMARY KEY,
    content            TEXT    NOT NULL,
    tier               TEXT    NOT NULL CHECK (tier IN ('micro','medium','deep')),
    source             TEXT    NOT NULL CHECK (source IN ('stream','interrupt','reflection','dream')),
    activated_concepts TEXT    NOT NULL DEFAULT '[]',
    emotional_valence  TEXT    NOT NULL DEFAULT '{}',
    body_state         TEXT    NOT NULL DEFAULT '{}',
    parent_thought_id  TEXT,
    depth              INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_thoughts_tier ON thoughts(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_thoughts_source ON thoughts(source)`,

  // ==========================================================================
  // WAVE 2: episodes (episodic-memory)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS episodes (
    id                TEXT    PRIMARY KEY,
    summary           TEXT    NOT NULL,
    participants      TEXT    NOT NULL DEFAULT '[]',
    topic             TEXT    NOT NULL DEFAULT '',
    tags              TEXT    NOT NULL DEFAULT '[]',
    emotional_valence TEXT    NOT NULL DEFAULT '{}',
    surprise_level    REAL    NOT NULL DEFAULT 0 CHECK (surprise_level BETWEEN 0 AND 1),
    outcome           TEXT    NOT NULL DEFAULT 'neutral'
                        CHECK (outcome IN ('positive','negative','neutral','mixed')),
    significance      REAL    NOT NULL DEFAULT 0.5 CHECK (significance BETWEEN 0 AND 1),
    session_id        TEXT,
    started_at        TEXT    NOT NULL,
    ended_at          TEXT    NOT NULL,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_significance ON episodes(significance DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome)`,

  // ==========================================================================
  // WAVE 2: procedures (procedural-memory)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS procedures (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    trigger_pattern TEXT    NOT NULL,
    steps           TEXT    NOT NULL,
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    avg_duration_ms REAL    NOT NULL DEFAULT 0,
    last_used       TEXT,
    compiled_from   TEXT    NOT NULL DEFAULT '[]',
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_procedures_enabled ON procedures(enabled)`,

  `CREATE TABLE IF NOT EXISTS tool_sequences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    sequence   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_sequences_session ON tool_sequences(session_id)`,

  // ==========================================================================
  // WAVE 2: intentions (prospective-memory)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS intentions (
    id                TEXT PRIMARY KEY,
    description       TEXT NOT NULL,
    trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('time','context','person','topic')),
    trigger_condition TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','triggered','completed','expired')),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    triggered_at      TEXT,
    completed_at      TEXT,
    expires_at        TEXT,
    source_episode_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_intentions_status ON intentions(status)`,

  // ==========================================================================
  // WAVE 2: drive_log (drive-system)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS drive_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    drives     TEXT    NOT NULL,
    dominant   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drive_log_created_at ON drive_log(created_at)`,

  // ==========================================================================
  // WAVE 3: world_model (predictions)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS world_model (
    id             TEXT    PRIMARY KEY,
    domain         TEXT    NOT NULL,
    prediction     TEXT    NOT NULL,
    confidence     REAL    NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    evidence_count INTEGER NOT NULL DEFAULT 0,
    made_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at     TEXT,
    last_validated TEXT,
    outcome        TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (outcome IN ('pending','confirmed','violated','expired')),
    actual_result  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_world_model_domain ON world_model(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_world_model_outcome ON world_model(outcome)`,
  `CREATE INDEX IF NOT EXISTS idx_world_model_expires ON world_model(expires_at)`,

  // ==========================================================================
  // WAVE 3: surprise_events
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS surprise_events (
    id              TEXT    PRIMARY KEY,
    prediction_id   TEXT    NOT NULL,
    magnitude       REAL    NOT NULL CHECK (magnitude BETWEEN 0 AND 1),
    direction       TEXT    NOT NULL CHECK (direction IN ('better','worse','different')),
    description     TEXT    NOT NULL,
    triggered_actions TEXT  NOT NULL DEFAULT '[]',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_surprise_magnitude ON surprise_events(magnitude DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_surprise_created_at ON surprise_events(created_at)`,

  // ==========================================================================
  // WAVE 3: self-model (capability assessments + personality)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS capability_assessments (
    domain          TEXT    PRIMARY KEY,
    level           TEXT    NOT NULL DEFAULT 'developing',
    confidence      REAL    NOT NULL DEFAULT 0.5,
    evidence_count  INTEGER NOT NULL DEFAULT 0,
    success_count   INTEGER NOT NULL DEFAULT 0,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    trend           TEXT    NOT NULL DEFAULT 'stable' CHECK (trend IN ('improving','stable','declining')),
    last_assessed   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS personality_observations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trait      TEXT    NOT NULL,
    value      REAL    NOT NULL CHECK (value BETWEEN 0 AND 1),
    source     TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_personality_trait ON personality_observations(trait)`,

  // ==========================================================================
  // WAVE 3: theory-of-mind (user models)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS user_models (
    user_id              TEXT PRIMARY KEY,
    traits               TEXT NOT NULL DEFAULT '{}',
    preferences          TEXT NOT NULL DEFAULT '{}',
    communication_style  TEXT NOT NULL DEFAULT 'standard',
    trust_level          REAL NOT NULL DEFAULT 0.5,
    known_triggers       TEXT NOT NULL DEFAULT '[]',
    known_delights       TEXT NOT NULL DEFAULT '[]',
    last_interaction     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    interaction_count    INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS user_interaction_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    message    TEXT NOT NULL,
    response   TEXT NOT NULL,
    outcome    TEXT NOT NULL DEFAULT 'neutral',
    inferred_mood TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_interaction_user ON user_interaction_log(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_interaction_time ON user_interaction_log(created_at)`,

  // ==========================================================================
  // WAVE 4: counterfactuals
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS counterfactuals (
    id                   TEXT    PRIMARY KEY,
    original_episode_id  TEXT    NOT NULL,
    alternative_action   TEXT    NOT NULL,
    simulated_outcome    TEXT    NOT NULL,
    actual_outcome       TEXT    NOT NULL,
    delta_assessment     TEXT    NOT NULL,
    lesson_learned       TEXT,
    confidence           REAL    NOT NULL DEFAULT 0.5,
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cf_episode ON counterfactuals(original_episode_id)`,

  // ==========================================================================
  // WAVE 4: temporal-self (snapshots + aspirations)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS self_snapshots (
    id             TEXT PRIMARY KEY,
    capabilities   TEXT NOT NULL,
    personality    TEXT NOT NULL,
    dominant_emotion TEXT NOT NULL,
    active_goals   TEXT NOT NULL DEFAULT '[]',
    snapshot_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS aspirations (
    id                TEXT PRIMARY KEY,
    description       TEXT NOT NULL,
    current_level     TEXT NOT NULL,
    target_level      TEXT NOT NULL,
    domain            TEXT NOT NULL,
    estimated_timeframe TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','abandoned')),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // WAVE 4: metacognition (reflections)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS reflections (
    id                 TEXT PRIMARY KEY,
    subject_episode_id TEXT NOT NULL,
    question           TEXT NOT NULL,
    analysis           TEXT NOT NULL,
    conclusion         TEXT NOT NULL,
    action_item        TEXT,
    quality_score      REAL NOT NULL DEFAULT 0.5,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reflections_episode ON reflections(subject_episode_id)`,
  // One reflection per episode. UNIQUE so concurrent runBatchReflection() can't write
  // duplicate rows (TOCTOU). On a legacy DB with existing dupes this CREATE fails and is
  // caught+warned by the fault-tolerant apply loop above — the SELECT pre-check still guards.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_reflections_subject_unique ON reflections(subject_episode_id)`,

  // ==========================================================================
  // WAVE 4: internal-dialogue (debates)
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS debates (
    id           TEXT PRIMARY KEY,
    question     TEXT NOT NULL,
    context      TEXT NOT NULL,
    positions    TEXT NOT NULL,
    resolution   TEXT NOT NULL,
    winning_voice TEXT NOT NULL,
    confidence   REAL NOT NULL DEFAULT 0.5,
    context_type TEXT NOT NULL DEFAULT 'general',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_debates_context_type ON debates(context_type)`,

  // ==========================================================================
  // WAVE 4: relationship-model
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS relationships (
    user_id                TEXT PRIMARY KEY,
    stage                  TEXT NOT NULL DEFAULT 'new',
    trust_trajectory       TEXT NOT NULL DEFAULT 'stable',
    shared_references      TEXT NOT NULL DEFAULT '[]',
    communication_evolution TEXT NOT NULL DEFAULT '',
    inside_jokes           TEXT NOT NULL DEFAULT '[]',
    conflict_history       TEXT NOT NULL DEFAULT '[]',
    total_interactions     INTEGER NOT NULL DEFAULT 0,
    first_interaction      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_interaction       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  // ==========================================================================
  // WAVE 5: sleep_sessions
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS sleep_sessions (
    id                      TEXT    PRIMARY KEY,
    episodes_replayed       INTEGER NOT NULL DEFAULT 0,
    patterns_found          INTEGER NOT NULL DEFAULT 0,
    memories_strengthened   INTEGER NOT NULL DEFAULT 0,
    memories_weakened       INTEGER NOT NULL DEFAULT 0,
    insights_generated      INTEGER NOT NULL DEFAULT 0,
    counterfactuals_run     INTEGER NOT NULL DEFAULT 0,
    dream_journal_entry     TEXT    NOT NULL DEFAULT '',
    duration_ms             INTEGER NOT NULL DEFAULT 0,
    started_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at                TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sleep_started ON sleep_sessions(started_at)`,

  // ==========================================================================
  // WAVE 5: evolution_proposals + digital_dna
  // ==========================================================================
  `CREATE TABLE IF NOT EXISTS evolution_proposals (
    id              TEXT    PRIMARY KEY,
    type            TEXT    NOT NULL CHECK (type IN ('code-fix','new-tool','soul-update','config-change')),
    target          TEXT    NOT NULL,
    description     TEXT    NOT NULL,
    current_code    TEXT,
    proposed_code   TEXT,
    reasoning       TEXT    NOT NULL,
    confidence      REAL    NOT NULL DEFAULT 0.5,
    status          TEXT    NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','approved','applied','rejected','failed')),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_status ON evolution_proposals(status)`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_type ON evolution_proposals(type)`,

  `CREATE TABLE IF NOT EXISTS digital_dna (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS failure_patterns (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    error_signature TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_failure_sig ON failure_patterns(error_signature)`,

];

// ---------------------------------------------------------------------------
// ConsciousnessDB
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of the consciousness SQLite database.
 *
 * Usage:
 * ```ts
 * const cdb = new ConsciousnessDB();            // default path
 * const cdb = new ConsciousnessDB('/tmp/test.db'); // override for tests
 *
 * const db = cdb.getDb();
 * db.prepare('SELECT * FROM body_state_log').all();
 * cdb.close();
 * ```
 */
export class ConsciousnessDB {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  /**
   * Open (or create) the consciousness database and apply the full schema.
   *
   * @param dbPath - Absolute or relative path to the SQLite file.
   *                 Defaults to `data/consciousness.db` under the project root.
   */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;

    // Ensure the parent directory exists before opening the file.
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        log.debug({ dir }, 'Created consciousness DB directory');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ConsciousnessError(
          `Failed to create DB directory: ${msg}`,
          'consciousness_db_mkdir_failed',
          { dir, cause: msg },
        );
      }
    }

    // Open the database — better-sqlite3 creates the file if it does not exist.
    try {
      this.db = new Database(dbPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `Failed to open consciousness DB at ${dbPath}: ${msg}`,
        'consciousness_db_open_failed',
        { dbPath, cause: msg },
      );
    }

    // Apply performance and safety PRAGMAs before schema init.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous  = NORMAL');
    this.db.pragma('foreign_keys = ON');

    log.info({ dbPath }, 'ConsciousnessDB opened (WAL mode)');

    this._applySchema();
  }

  // -------------------------------------------------------------------------
  // Schema initialisation
  // -------------------------------------------------------------------------

  /**
   * Execute all schema DDL statements idempotently.
   * Logs a warning for unexpected errors but does not throw on `already exists`.
   */
  private _applySchema(): void {
    let applied = 0;

    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        this.db.exec(stmt);
        applied++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          log.warn(
            { stmt: stmt.slice(0, 80), error: msg },
            'ConsciousnessDB schema warning',
          );
        }
      }
    }

    log.debug({ applied, total: SCHEMA_STATEMENTS.length }, 'Schema applied');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the underlying better-sqlite3 Database instance.
   * Use this to prepare and run statements.
   *
   * @throws ConsciousnessError if the database is not open.
   */
  getDb(): Database.Database {
    if (!this.db.open) {
      throw new ConsciousnessError(
        'ConsciousnessDB is closed',
        'consciousness_db_not_open',
        { dbPath: this.dbPath },
      );
    }
    return this.db;
  }

  /**
   * Close the database connection, flushing WAL frames to the main file.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close(): void {
    if (this.db.open) {
      this.db.close();
      log.info({ dbPath: this.dbPath }, 'ConsciousnessDB closed');
    }
  }
}
