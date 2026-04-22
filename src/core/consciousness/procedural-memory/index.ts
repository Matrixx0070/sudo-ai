/**
 * @file index.ts
 * @description ProceduralMemory — public facade for the procedural-memory
 * subsystem of SUDO-AI v4.
 *
 * Wraps detector, compiler, and store behind a single class so consumers
 * never need to import the lower-level modules directly.
 *
 * Usage:
 * ```ts
 * const pm = new ProceduralMemory(consciousnessDB);
 * pm.observeToolSequence(sessionId, toolCalls);
 * const procedure = pm.findMatchingProcedure('coder.read-file then coder.write-file');
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import { observeSequence, findRepeatedPatterns } from './detector.js';
import { compileProcedure } from './compiler.js';
import {
  saveProcedure,
  getProcedures,
  findMatchingProcedure,
} from './store.js';
import { updateProcedureStats, disableProcedure } from './store-stats.js';
import type { Procedure, ToolCallRecord } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('procedural-memory');

// ---------------------------------------------------------------------------
// ProceduralMemory
// ---------------------------------------------------------------------------

/**
 * High-level interface for the procedural-memory subsystem.
 *
 * Lifecycle:
 * 1. Call `observeToolSequence` after each AI action batch.
 * 2. Periodically call `checkForNewProcedures` to compile any patterns that
 *    have hit the threshold.
 * 3. Call `findMatchingProcedure` before executing a task to see if a known
 *    procedure covers it.
 */
export class ProceduralMemory {
  private readonly cdb: ConsciousnessDB;

  /**
   * @param cdb - Open ConsciousnessDB instance (caller owns lifecycle).
   */
  constructor(cdb: ConsciousnessDB) {
    if (!cdb) {
      throw new ConsciousnessError(
        'ProceduralMemory: cdb must be a ConsciousnessDB instance',
        'consciousness_procedural_invalid_db',
        {},
      );
    }
    this.cdb = cdb;
    log.info('ProceduralMemory: initialised');
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /**
   * Record a tool-call sequence for the given session.
   * If this exact sequence has now been seen 3+ times, returns the candidate
   * pattern; otherwise returns null.
   *
   * @param sessionId - Identifier for the current session.
   * @param toolCalls - Ordered tool calls observed this session.
   */
  observeToolSequence(
    sessionId: string,
    toolCalls: ToolCallRecord[],
  ): { pattern: string[]; occurrences: number; sessionIds: string[] } | null {
    log.debug({ sessionId, toolCallCount: toolCalls.length }, 'observeToolSequence: called');

    const db = this.cdb.getDb();
    return observeSequence(db, sessionId, toolCalls);
  }

  // -------------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------------

  /**
   * Find the best-matching enabled procedure for a given context string.
   * Returns null if no procedure matches.
   *
   * @param context - Free-text describing the current task or sequence of
   *                  tool names joined by " then ".
   */
  findMatchingProcedure(context: string): Procedure | null {
    log.debug({ context }, 'findMatchingProcedure: called');
    const db = this.cdb.getDb();
    return findMatchingProcedure(db, context);
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  /**
   * Return all stored procedures.
   *
   * @param enabledOnly - When true, only return enabled procedures.
   */
  getProcedures(enabledOnly = false): Procedure[] {
    log.debug({ enabledOnly }, 'getProcedures: called');
    const db = this.cdb.getDb();
    return getProcedures(db, enabledOnly);
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  /**
   * Disable a procedure by ID.
   * The row is kept in the DB for auditing; the procedure will no longer match.
   *
   * @param id - Procedure ID to disable.
   */
  disableProcedure(id: string): void {
    log.debug({ id }, 'disableProcedure: called');
    const db = this.cdb.getDb();
    disableProcedure(db, id);
  }

  /**
   * Update execution statistics after a procedure run.
   *
   * @param id         - Procedure ID.
   * @param success    - Whether the execution succeeded.
   * @param durationMs - Wall-clock duration of the run in milliseconds.
   */
  recordExecution(id: string, success: boolean, durationMs: number): void {
    log.debug({ id, success, durationMs }, 'recordExecution: called');
    const db = this.cdb.getDb();
    updateProcedureStats(db, id, success, durationMs);
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  /**
   * Scan for repeated patterns in `tool_sequences` and compile any that have
   * not yet been turned into a Procedure.
   *
   * Skips patterns whose triggerPattern already exists in the `procedures`
   * table to avoid duplicate compilation.
   *
   * @param minOccurrences - Minimum hit count before compilation (default 3).
   * @returns Array of newly compiled and saved Procedure objects.
   */
  checkForNewProcedures(minOccurrences = 3): Procedure[] {
    log.info({ minOccurrences }, 'checkForNewProcedures: scanning for compilable patterns');

    const db = this.cdb.getDb();

    const candidates = findRepeatedPatterns(db, minOccurrences);
    if (candidates.length === 0) {
      log.debug('checkForNewProcedures: no candidates found');
      return [];
    }

    // Build set of already-compiled trigger patterns to avoid duplicates.
    const existing = getProcedures(db, false);
    const existingPatterns = new Set(existing.map((p) => p.triggerPattern));

    const compiled: Procedure[] = [];

    for (const candidate of candidates) {
      const triggerPattern = candidate.pattern.join(' then ');
      if (existingPatterns.has(triggerPattern)) {
        log.debug(
          { triggerPattern },
          'checkForNewProcedures: pattern already compiled — skipping',
        );
        continue;
      }

      try {
        const procedure = compileProcedure(candidate.pattern, candidate.sessionIds);
        saveProcedure(db, procedure);
        compiled.push(procedure);
        existingPatterns.add(triggerPattern); // guard against duplicates in same batch
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { triggerPattern, error: msg },
          'checkForNewProcedures: failed to compile/save procedure — continuing',
        );
      }
    }

    log.info(
      { newProcedures: compiled.length, candidatesChecked: candidates.length },
      'checkForNewProcedures: compilation pass complete',
    );

    return compiled;
  }
}

// ---------------------------------------------------------------------------
// Re-export types for consumers
// ---------------------------------------------------------------------------

export type { Procedure, ProcedureStep, ToolCallRecord } from './types.js';
