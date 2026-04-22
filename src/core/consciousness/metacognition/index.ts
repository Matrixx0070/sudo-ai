/**
 * @file index.ts
 * @description Public API for the metacognition subsystem.
 *
 * MetacognitionEngine wraps reflector + store operations behind a single
 * class. Requires an open ConsciousnessDB and a MetaBrainLike implementor.
 *
 * Usage:
 * ```ts
 * const engine = new MetacognitionEngine(cdb, brain);
 * const r = await engine.reflect(episodeId, summary, outcome);
 * const batch = await engine.runBatchReflection(episodicMemory, 5);
 * const history = engine.getByEpisode(episodeId);
 * ```
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { MetaBrainLike, MetaEpisodicLike, Reflection } from './types.js';
import { reflect, runBatchReflection } from './reflector.js';
import { getByEpisode, getReflections } from './store.js';

// Re-export types for consumers.
export type { Reflection, MetaBrainLike, MetaEpisodicLike } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('metacognition');

// ---------------------------------------------------------------------------
// MetacognitionEngine
// ---------------------------------------------------------------------------

/**
 * High-level controller for metacognitive reflection.
 *
 * All async methods delegate to reflector.ts; synchronous read methods
 * delegate to store.ts. Input validation occurs before any delegation.
 */
export class MetacognitionEngine {
  private readonly cdb: ConsciousnessDB;
  private readonly brain: MetaBrainLike;

  /**
   * @param cdb   - An open ConsciousnessDB instance.
   * @param brain - A MetaBrainLike LLM brain implementation.
   * @throws ConsciousnessError if arguments are invalid.
   */
  constructor(cdb: ConsciousnessDB, brain: MetaBrainLike) {
    if (!cdb || typeof cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'MetacognitionEngine: cdb must be a valid ConsciousnessDB instance',
        'consciousness_meta_invalid_input',
        { received: typeof cdb },
      );
    }
    if (!brain || typeof brain.call !== 'function') {
      throw new ConsciousnessError(
        'MetacognitionEngine: brain must implement MetaBrainLike',
        'consciousness_meta_invalid_input',
        { received: typeof brain },
      );
    }

    this.cdb = cdb;
    this.brain = brain;
    log.info('MetacognitionEngine initialised');
  }

  // -------------------------------------------------------------------------
  // Write / reflect
  // -------------------------------------------------------------------------

  /**
   * Generate and persist a metacognitive reflection for a specific episode.
   *
   * @param episodeId      - ID of the subject episode.
   * @param episodeSummary - Natural-language summary of the episode.
   * @param outcome        - Episode outcome string.
   * @returns The saved Reflection record.
   * @throws ConsciousnessError on validation or LLM failure.
   */
  async reflect(
    episodeId: string,
    episodeSummary: string,
    outcome: string,
  ): Promise<Reflection> {
    if (!episodeId || typeof episodeId !== 'string') {
      throw new ConsciousnessError(
        'MetacognitionEngine.reflect: episodeId must be a non-empty string',
        'consciousness_meta_invalid_input',
        { episodeId },
      );
    }

    log.info({ episodeId }, 'reflect() called');

    return reflect(this.brain, this.cdb.getDb(), episodeId, episodeSummary, outcome);
  }

  /**
   * Batch-reflect over recent significant episodes that have not yet been
   * reflected on.
   *
   * @param episodicMemory - Episodic memory interface for retrieving episodes.
   * @param count          - Number of episodes to consider.
   * @returns Array of newly created Reflection records.
   * @throws ConsciousnessError on invalid input.
   */
  async runBatchReflection(
    episodicMemory: MetaEpisodicLike,
    count: number,
  ): Promise<Reflection[]> {
    if (!episodicMemory || typeof episodicMemory.getBySignificance !== 'function') {
      throw new ConsciousnessError(
        'MetacognitionEngine.runBatchReflection: episodicMemory must implement MetaEpisodicLike',
        'consciousness_meta_invalid_input',
        { received: typeof episodicMemory },
      );
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'MetacognitionEngine.runBatchReflection: count must be a positive integer',
        'consciousness_meta_invalid_input',
        { count },
      );
    }

    log.info({ count }, 'runBatchReflection() called');

    return runBatchReflection(this.brain, this.cdb.getDb(), episodicMemory, count);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Return all reflections for a given episode.
   *
   * @param episodeId - Episode ID to look up.
   * @returns Array of matching reflections (may be empty).
   * @throws ConsciousnessError on invalid input or DB failure.
   */
  getByEpisode(episodeId: string): Reflection[] {
    if (!episodeId || typeof episodeId !== 'string') {
      throw new ConsciousnessError(
        'MetacognitionEngine.getByEpisode: episodeId must be a non-empty string',
        'consciousness_meta_invalid_input',
        { episodeId },
      );
    }

    log.debug({ episodeId }, 'getByEpisode() called');
    return getByEpisode(this.cdb.getDb(), episodeId);
  }

  /**
   * Return the N most recently created reflections across all episodes.
   *
   * @param limit - Number of records to return (>= 1).
   * @returns Array of reflections ordered by created_at DESC.
   * @throws ConsciousnessError on invalid input or DB failure.
   */
  getReflections(limit: number): Reflection[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConsciousnessError(
        'MetacognitionEngine.getReflections: limit must be a positive integer',
        'consciousness_meta_invalid_input',
        { limit },
      );
    }

    log.debug({ limit }, 'getReflections() called');
    return getReflections(this.cdb.getDb(), limit);
  }
}
