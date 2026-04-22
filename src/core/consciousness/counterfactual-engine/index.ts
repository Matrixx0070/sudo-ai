/**
 * @file index.ts
 * @description Public API for the counterfactual-engine subsystem.
 *
 * CounterfactualEngine wraps simulator + store operations behind a single
 * class. Requires an open ConsciousnessDB and a CFBrainLike implementor.
 *
 * Usage:
 * ```ts
 * const engine = new CounterfactualEngine(cdb, brain);
 * const cf = await engine.simulate(episodeId, summary, outcome, altAction);
 * const batch = await engine.runIdleBatch(episodicMemory, 5);
 * const history = engine.getByEpisode(episodeId);
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { CFBrainLike, CFEpisodicLike, Counterfactual } from './types.js';
import { simulate, runIdleBatch } from './simulator.js';
import { getByEpisode, getRecent } from './store.js';

// Re-export types for consumers.
export type { Counterfactual, CFBrainLike, CFEpisodicLike } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('counterfactual-engine');

// ---------------------------------------------------------------------------
// CounterfactualEngine
// ---------------------------------------------------------------------------

/**
 * High-level controller for counterfactual simulation.
 *
 * All async methods delegate to simulator.ts; synchronous read methods
 * delegate to store.ts. Input validation occurs before any delegation.
 */
export class CounterfactualEngine {
  private readonly cdb: ConsciousnessDB;
  private readonly brain: CFBrainLike;

  /**
   * @param cdb   - An open ConsciousnessDB instance.
   * @param brain - A CFBrainLike LLM brain implementation.
   * @throws ConsciousnessError if arguments are invalid.
   */
  constructor(cdb: ConsciousnessDB, brain: CFBrainLike) {
    if (!cdb || typeof cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'CounterfactualEngine: cdb must be a valid ConsciousnessDB instance',
        'consciousness_cf_invalid_input',
        { received: typeof cdb },
      );
    }
    if (!brain || typeof brain.call !== 'function') {
      throw new ConsciousnessError(
        'CounterfactualEngine: brain must implement CFBrainLike',
        'consciousness_cf_invalid_input',
        { received: typeof brain },
      );
    }

    this.cdb = cdb;
    this.brain = brain;
    log.info('CounterfactualEngine initialised');
  }

  // -------------------------------------------------------------------------
  // Write / simulate
  // -------------------------------------------------------------------------

  /**
   * Generate and persist a counterfactual for a specific episode.
   *
   * @param episodeId         - ID of the source episode.
   * @param episodeSummary    - Natural-language summary of the episode.
   * @param actualOutcome     - What actually happened.
   * @param alternativeAction - The alternative action to evaluate.
   * @returns The saved Counterfactual record.
   * @throws ConsciousnessError on validation or LLM failure.
   */
  async simulate(
    episodeId: string,
    episodeSummary: string,
    actualOutcome: string,
    alternativeAction: string,
  ): Promise<Counterfactual> {
    if (!episodeId || typeof episodeId !== 'string') {
      throw new ConsciousnessError(
        'CounterfactualEngine.simulate: episodeId must be a non-empty string',
        'consciousness_cf_invalid_input',
        { episodeId },
      );
    }

    log.info({ episodeId }, 'simulate() called');

    return simulate(
      this.brain,
      this.cdb.getDb(),
      episodeId,
      episodeSummary,
      actualOutcome,
      alternativeAction,
    );
  }

  /**
   * Batch-generate counterfactuals for recent significant episodes that have
   * not yet been processed.
   *
   * @param episodicMemory - Episodic memory interface for retrieving episodes.
   * @param count          - Number of episodes to consider.
   * @returns Array of newly created Counterfactual records.
   * @throws ConsciousnessError on invalid input.
   */
  async runIdleBatch(
    episodicMemory: CFEpisodicLike,
    count: number,
  ): Promise<Counterfactual[]> {
    if (!episodicMemory || typeof episodicMemory.getBySignificance !== 'function') {
      throw new ConsciousnessError(
        'CounterfactualEngine.runIdleBatch: episodicMemory must implement CFEpisodicLike',
        'consciousness_cf_invalid_input',
        { received: typeof episodicMemory },
      );
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'CounterfactualEngine.runIdleBatch: count must be a positive integer',
        'consciousness_cf_invalid_input',
        { count },
      );
    }

    log.info({ count }, 'runIdleBatch() called');

    return runIdleBatch(this.brain, this.cdb.getDb(), episodicMemory, count);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Return all counterfactuals for a given episode.
   *
   * @param episodeId - Episode ID to look up.
   * @returns Array of matching counterfactuals (may be empty).
   * @throws ConsciousnessError on invalid input or DB failure.
   */
  getByEpisode(episodeId: string): Counterfactual[] {
    if (!episodeId || typeof episodeId !== 'string') {
      throw new ConsciousnessError(
        'CounterfactualEngine.getByEpisode: episodeId must be a non-empty string',
        'consciousness_cf_invalid_input',
        { episodeId },
      );
    }

    log.debug({ episodeId }, 'getByEpisode() called');
    return getByEpisode(this.cdb.getDb(), episodeId);
  }

  /**
   * Return the N most recently created counterfactuals.
   *
   * @param count - Number of records to return (>= 1).
   * @returns Array of counterfactuals ordered by created_at DESC.
   * @throws ConsciousnessError on invalid input or DB failure.
   */
  getRecent(count: number): Counterfactual[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'CounterfactualEngine.getRecent: count must be a positive integer',
        'consciousness_cf_invalid_input',
        { count },
      );
    }

    log.debug({ count }, 'getRecent() called');
    return getRecent(this.cdb.getDb(), count);
  }
}
