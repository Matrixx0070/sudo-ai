/**
 * compiler-io.ts — File-system helpers for the SkillCompiler.
 * Separated to keep compiler.ts under the 300-line module limit.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { SkillDefinition, SkillRow, SkillRecord } from './compiler.js';

const logger = createLogger('skill-compiler-io');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Skill name must be a non-empty string');
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Skill name must match "<category>.<slug>" pattern (lowercase, hyphens ok): got "${name}"`,
    );
  }
}

export function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Skill version must be semver (e.g. "1.0.0"): got "${version}"`);
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function openDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`mind.db not found at ${dbPath} — is SUDO-AI initialised?`);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function rowToRecord(row: SkillRow): SkillRecord {
  let inputSchema: object = {};
  let outputSchema: object = {};
  try { inputSchema = JSON.parse(row.input_schema) as object; } catch { /* use empty */ }
  try { outputSchema = JSON.parse(row.output_schema) as object; } catch { /* use empty */ }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description ?? '',
    entryPath: row.entry_path,
    inputSchema,
    outputSchema,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// File-system write
// ---------------------------------------------------------------------------

export function writeSkillFiles(skillDir: string, entryPath: string, def: SkillDefinition): void {
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
    logger.debug({ skillDir }, 'Created skill directory');
  }
  writeFileSync(entryPath, def.implementation, 'utf8');
  logger.debug({ entryPath }, 'Wrote skill implementation');

  const docPath = join(skillDir, 'SKILL.md');
  writeFileSync(docPath, def.docs, 'utf8');
  logger.debug({ docPath }, 'Wrote skill documentation');
}

export function removeSkillDirectory(entryPath: string, skillName: string): void {
  // entry_path is <skillDir>/index.ts — the directory is one level up
  const parts = entryPath.split('/');
  parts.pop(); // remove 'index.ts'
  const skillDir = parts.join('/');

  if (existsSync(skillDir)) {
    try {
      rmSync(skillDir, { recursive: true, force: true });
      logger.info({ skillDir }, 'Skill source directory removed');
    } catch (err) {
      logger.warn({ skillDir, skillName, err }, 'Could not remove skill directory — DB record already deleted');
    }
  }
}
