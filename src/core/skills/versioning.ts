/**
 * Skill Versioning — git-like version control for SUDO-AI self-compiled skills.
 *
 * Each time a skill is compiled or updated a new row is inserted into
 * `skill_versions` in mind.db and marked active.  Rolling back flips the
 * active flag to any prior row.  Performance metrics accumulate per version so
 * `getBestVersion` can recommend the historically best build.
 *
 * Types, DDL, and row helpers live in versioning-io.ts (module split for the
 * 300-line-per-file rule).
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import {
  SKILL_VERSIONS_DDL,
  rowToVersion,
  validateSkillName,
  validateSourceCode,
  validateSemver,
  type VersionRow,
} from './versioning-io.js';

// Re-export public types so callers only need one import path.
export type { SkillVersion, SkillDiff } from './versioning-io.js';

const logger = createLogger('skill-versioning');

/**
 * Version-control layer for SUDO-AI skills.
 *
 * ```ts
 * const sv = new SkillVersioning('<project-root>/data/mind.db');
 * const id = sv.saveVersion('research.web-summary', '1.0.0', src, 'initial');
 * sv.recordExecution('research.web-summary', true, 142);
 * const best = sv.getBestVersion('research.web-summary');
 * sv.close();
 * ```
 */
export class SkillVersioning {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`mind.db not found at ${dbPath} — is SUDO-AI initialised?`);
    }
    logger.info({ dbPath }, 'SkillVersioning opening DB');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SKILL_VERSIONS_DDL);
    logger.debug('SkillVersioning DDL applied');
  }

  // -------------------------------------------------------------------------
  // saveVersion — Persist a new compiled version and mark it active.
  // -------------------------------------------------------------------------

  /** Any previously active version for this skill is deactivated first.
   * @returns The auto-generated row `id`. */
  saveVersion(
    skillName: string,
    version: string,
    sourceCode: string,
    changelog: string,
  ): number {
    validateSkillName(skillName);
    validateSemver(version);
    validateSourceCode(sourceCode);

    const log = typeof changelog === 'string' ? changelog : '';
    logger.info({ skillName, version }, 'Saving new skill version');

    const save = this.db.transaction((): number => {
      this.db
        .prepare<{ skill_name: string }>(
          'UPDATE skill_versions SET active = 0 WHERE skill_name = :skill_name',
        )
        .run({ skill_name: skillName });

      const info = this.db
        .prepare<{ skill_name: string; version: string; source_code: string; changelog: string }>(
          `INSERT INTO skill_versions (skill_name, version, source_code, changelog, active)
           VALUES (:skill_name, :version, :source_code, :changelog, 1)
           ON CONFLICT(skill_name, version) DO UPDATE SET
             source_code    = excluded.source_code,
             changelog      = excluded.changelog,
             active         = 1,
             executions     = 0,
             successes      = 0,
             failures       = 0,
             avg_latency_ms = 0`,
        )
        .run({ skill_name: skillName, version, source_code: sourceCode, changelog: log });

      return info.lastInsertRowid as number;
    });

    const rowId = save();
    logger.info({ skillName, version, rowId }, 'Skill version saved');
    return rowId;
  }

  // -------------------------------------------------------------------------
  // getVersions
  // -------------------------------------------------------------------------

  /** Return all versions for a skill, newest first. */
  getVersions(skillName: string): ReturnType<typeof rowToVersion>[] {
    validateSkillName(skillName);
    logger.debug({ skillName }, 'Listing skill versions');

    const rows = this.db
      .prepare<{ skill_name: string }, VersionRow>(
        'SELECT * FROM skill_versions WHERE skill_name = :skill_name ORDER BY id DESC',
      )
      .all({ skill_name: skillName });

    return rows.map(rowToVersion);
  }

  // -------------------------------------------------------------------------
  // rollback — Activate a specific historical version by row id.
  // -------------------------------------------------------------------------

  /** @throws Error if the version id is not found for this skill. */
  rollback(skillName: string, versionId: number): void {
    validateSkillName(skillName);
    if (!Number.isInteger(versionId) || versionId <= 0) {
      throw new Error(`versionId must be a positive integer: got ${versionId}`);
    }

    logger.info({ skillName, versionId }, 'Rolling back skill version');

    const rb = this.db.transaction(() => {
      const row = this.db
        .prepare<{ id: number; skill_name: string }, VersionRow>(
          'SELECT * FROM skill_versions WHERE id = :id AND skill_name = :skill_name',
        )
        .get({ id: versionId, skill_name: skillName });

      if (!row) {
        throw new Error(`Version id=${versionId} not found for skill "${skillName}"`);
      }

      this.db
        .prepare<{ skill_name: string }>(
          'UPDATE skill_versions SET active = 0 WHERE skill_name = :skill_name',
        )
        .run({ skill_name: skillName });

      this.db
        .prepare<{ id: number }>('UPDATE skill_versions SET active = 1 WHERE id = :id')
        .run({ id: versionId });
    });

    rb();
    logger.info({ skillName, versionId }, 'Rollback complete');
  }

  // -------------------------------------------------------------------------
  // getActive
  // -------------------------------------------------------------------------

  /** Return the currently active version for a skill, or null. */
  getActive(skillName: string): ReturnType<typeof rowToVersion> | null {
    validateSkillName(skillName);
    const row = this.db
      .prepare<{ skill_name: string }, VersionRow>(
        'SELECT * FROM skill_versions WHERE skill_name = :skill_name AND active = 1 LIMIT 1',
      )
      .get({ skill_name: skillName });

    return row ? rowToVersion(row) : null;
  }

  // -------------------------------------------------------------------------
  // recordExecution
  // -------------------------------------------------------------------------

  /**
   * Append one execution result to the active version's counters.
   * Uses incremental averaging for avg_latency_ms.
   */
  recordExecution(skillName: string, success: boolean, latencyMs: number): void {
    validateSkillName(skillName);
    if (typeof latencyMs !== 'number' || latencyMs < 0) {
      throw new Error(`latencyMs must be a non-negative number: got ${latencyMs}`);
    }

    const row = this.db
      .prepare<{ skill_name: string }, VersionRow>(
        'SELECT * FROM skill_versions WHERE skill_name = :skill_name AND active = 1 LIMIT 1',
      )
      .get({ skill_name: skillName });

    if (!row) {
      logger.warn({ skillName }, 'recordExecution: no active version found, skipping');
      return;
    }

    const newExec = row.executions + 1;
    const newSuccesses = success ? row.successes + 1 : row.successes;
    const newFailures = success ? row.failures : row.failures + 1;
    const newAvg = row.avg_latency_ms + (latencyMs - row.avg_latency_ms) / newExec;

    this.db
      .prepare<{ id: number; executions: number; successes: number; failures: number; avg_latency_ms: number }>(
        `UPDATE skill_versions
         SET executions = :executions, successes = :successes,
             failures = :failures, avg_latency_ms = :avg_latency_ms
         WHERE id = :id`,
      )
      .run({ id: row.id, executions: newExec, successes: newSuccesses, failures: newFailures, avg_latency_ms: newAvg });

    logger.debug({ skillName, success, latencyMs, versionId: row.id }, 'Execution recorded');
  }

  // -------------------------------------------------------------------------
  // diff
  // -------------------------------------------------------------------------

  /**
   * Return line-level added/removed sets between two version rows.
   *
   * @param versionA - Row id of the "before" version.
   * @param versionB - Row id of the "after" version.
   */
  diff(skillName: string, versionA: number, versionB: number): { added: string[]; removed: string[] } {
    validateSkillName(skillName);

    const getRow = (id: number): VersionRow => {
      const r = this.db
        .prepare<{ id: number; skill_name: string }, VersionRow>(
          'SELECT * FROM skill_versions WHERE id = :id AND skill_name = :skill_name',
        )
        .get({ id, skill_name: skillName });
      if (!r) throw new Error(`Version id=${id} not found for skill "${skillName}"`);
      return r;
    };

    const rowA = getRow(versionA);
    const rowB = getRow(versionB);
    const linesA = new Set(rowA.source_code.split('\n'));
    const linesB = new Set(rowB.source_code.split('\n'));

    const added = [...linesB].filter(l => !linesA.has(l));
    const removed = [...linesA].filter(l => !linesB.has(l));

    logger.debug({ skillName, versionA, versionB, added: added.length, removed: removed.length }, 'Diff computed');
    return { added, removed };
  }

  // -------------------------------------------------------------------------
  // getBestVersion
  // -------------------------------------------------------------------------

  /**
   * Return the version with the highest success rate (successes/executions).
   * Versions with zero executions are excluded.
   */
  getBestVersion(skillName: string): ReturnType<typeof rowToVersion> | null {
    validateSkillName(skillName);

    const row = this.db
      .prepare<{ skill_name: string }, VersionRow>(
        `SELECT *,
                CAST(successes AS REAL) / NULLIF(executions, 0) AS success_rate
         FROM skill_versions
         WHERE skill_name = :skill_name
           AND executions > 0
         ORDER BY success_rate DESC, avg_latency_ms ASC
         LIMIT 1`,
      )
      .get({ skill_name: skillName });

    if (!row) {
      logger.debug({ skillName }, 'getBestVersion: no executed versions found');
      return null;
    }

    logger.debug({ skillName, bestId: row.id }, 'Best version selected');
    return rowToVersion(row);
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close();
    logger.debug('SkillVersioning DB closed');
  }
}
