/**
 * Skill Compiler — SUDO-AI creates its own skills.
 *
 * When SUDO identifies a repeated pattern (3+ times), it compiles a reusable
 * skill with: implementation files, documentation, and a mind.db registration.
 *
 * File layout written for each skill:
 *   src/core/skills/<category>/<name>/index.ts   — implementation
 *   src/core/skills/<category>/<name>/SKILL.md   — documentation
 *
 * DB record: skills table in mind.db (id, name, version, description,
 *   entry_path, input_schema, output_schema, enabled).
 *
 * File-system and DB I/O helpers live in compiler-io.ts (module split for
 * the 300-line-per-file rule).
 */

import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  validateName,
  validateVersion,
  openDb,
  rowToRecord,
  writeSkillFiles,
  removeSkillDirectory,
} from './compiler-io.js';

const logger = createLogger('skill-compiler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(process.cwd());
const SKILLS_SRC_DIR = join(PROJECT_ROOT, 'src', 'core', 'skills');
const DB_PATH = join(PROJECT_ROOT, 'data', 'mind.db');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  /** Dot-namespaced skill name, e.g. "research.web-summary" */
  name: string;
  /** Semantic version, e.g. "1.0.0" */
  version: string;
  /** One-sentence human description */
  description: string;
  /** Category slug matching the directory, e.g. "research" */
  category: string;
  /** JSON Schema object describing inputs */
  inputSchema: object;
  /** JSON Schema object describing outputs */
  outputSchema: object;
  /** TypeScript source code for the skill's index.ts */
  implementation: string;
  /** Markdown documentation for SKILL.md */
  docs: string;
  /** Optional npm dependencies the skill declares */
  dependencies?: string[];
}

export interface SkillRow {
  id: number;
  name: string;
  version: string;
  description: string | null;
  entry_path: string;
  input_schema: string;
  output_schema: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SkillRecord {
  id: number;
  name: string;
  version: string;
  description: string;
  entryPath: string;
  inputSchema: object;
  outputSchema: object;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Re-export for convenience
export { rowToRecord };

// ---------------------------------------------------------------------------
// SkillCompiler
// ---------------------------------------------------------------------------

/**
 * Compiles, registers, and manages SUDO-AI skills.
 *
 * Usage:
 * ```ts
 * const compiler = new SkillCompiler();
 * compiler.compileSkill(def);
 * const skills = compiler.listSkills();
 * compiler.close();
 * ```
 */
export class SkillCompiler {
  private readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    logger.info({ dbPath }, 'SkillCompiler initialising');
    this.db = openDb(dbPath);
  }

  // -------------------------------------------------------------------------
  // compileSkill
  // -------------------------------------------------------------------------

  /**
   * Write skill source files and register the skill in mind.db.
   *
   * @param def - Complete skill definition including implementation and docs.
   * @returns The registered SkillRecord.
   * @throws Error if validation fails or file I/O fails.
   */
  compileSkill(def: SkillDefinition): SkillRecord {
    logger.info({ name: def.name, version: def.version }, 'Compiling skill');

    validateName(def.name);
    validateVersion(def.version);
    if (!def.description?.trim()) throw new Error('Skill description is required');
    if (!def.category?.trim()) throw new Error('Skill category is required');
    if (!def.implementation?.trim()) throw new Error('Skill implementation code is required');
    if (!def.docs?.trim()) throw new Error('Skill documentation is required');

    const [, slug] = def.name.split('.');
    const skillDir = join(SKILLS_SRC_DIR, def.category, slug!);
    const entryPath = join(skillDir, 'index.ts');

    writeSkillFiles(skillDir, entryPath, def);

    const record = this._upsertSkillRecord(def, entryPath);
    logger.info({ name: def.name, entryPath }, 'Skill compiled and registered');
    return record;
  }

  // -------------------------------------------------------------------------
  // listSkills
  // -------------------------------------------------------------------------

  /** Return all skill records from mind.db, enabled and disabled. */
  listSkills(): SkillRecord[] {
    logger.debug('Listing all skills');
    const rows = this.db
      .prepare<[], SkillRow>('SELECT * FROM skills ORDER BY name ASC')
      .all();
    return rows.map(rowToRecord);
  }

  // -------------------------------------------------------------------------
  // getSkill
  // -------------------------------------------------------------------------

  /** Return a single skill by name, or undefined if not found. */
  getSkill(name: string): SkillRecord | undefined {
    validateName(name);
    const row = this.db
      .prepare<{ name: string }, SkillRow>('SELECT * FROM skills WHERE name = :name')
      .get({ name });
    return row ? rowToRecord(row) : undefined;
  }

  // -------------------------------------------------------------------------
  // enableSkill / disableSkill
  // -------------------------------------------------------------------------

  /** Enable a previously disabled skill. */
  enableSkill(name: string): void {
    validateName(name);
    logger.info({ name }, 'Enabling skill');
    const info = this.db
      .prepare<{ name: string }>('UPDATE skills SET enabled = 1 WHERE name = :name')
      .run({ name });
    if (info.changes === 0) throw new Error(`Skill not found: ${name}`);
  }

  /** Disable a skill without deleting it from disk or DB. */
  disableSkill(name: string): void {
    validateName(name);
    logger.info({ name }, 'Disabling skill');
    const info = this.db
      .prepare<{ name: string }>('UPDATE skills SET enabled = 0 WHERE name = :name')
      .run({ name });
    if (info.changes === 0) throw new Error(`Skill not found: ${name}`);
  }

  // -------------------------------------------------------------------------
  // deleteSkill
  // -------------------------------------------------------------------------

  /**
   * Remove the skill DB record and source files.
   * @param name - Skill name e.g. "research.web-summary"
   */
  deleteSkill(name: string): void {
    validateName(name);
    logger.info({ name }, 'Deleting skill');

    const row = this.db
      .prepare<{ name: string }, SkillRow>('SELECT * FROM skills WHERE name = :name')
      .get({ name });
    if (!row) throw new Error(`Skill not found: ${name}`);

    this.db.prepare<{ name: string }>('DELETE FROM skills WHERE name = :name').run({ name });
    removeSkillDirectory(row.entry_path, name);
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  /** Close the underlying DB connection. */
  close(): void {
    this.db.close();
    logger.debug('SkillCompiler DB closed');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _upsertSkillRecord(def: SkillDefinition, entryPath: string): SkillRecord {
    const inputSchemaJson = JSON.stringify(def.inputSchema);
    const outputSchemaJson = JSON.stringify(def.outputSchema);

    this.db.prepare(`
      INSERT INTO skills (name, version, description, entry_path, input_schema, output_schema, enabled)
      VALUES (:name, :version, :description, :entry_path, :input_schema, :output_schema, 1)
      ON CONFLICT(name) DO UPDATE SET
        version       = excluded.version,
        description   = excluded.description,
        entry_path    = excluded.entry_path,
        input_schema  = excluded.input_schema,
        output_schema = excluded.output_schema
    `).run({
      name:          def.name,
      version:       def.version,
      description:   def.description,
      entry_path:    entryPath,
      input_schema:  inputSchemaJson,
      output_schema: outputSchemaJson,
    });

    return rowToRecord(
      this.db
        .prepare<{ name: string }, SkillRow>('SELECT * FROM skills WHERE name = :name')
        .get({ name: def.name })!,
    );
  }
}
