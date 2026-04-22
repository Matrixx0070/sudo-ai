/**
 * @file index.ts
 * @description InternalDialogue — public façade for the internal-dialogue module.
 *
 * Orchestrates debate execution, persistence, and weight introspection.
 * Consumers depend only on this class; they never import from sub-modules directly.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import { runDebate } from './debate.js';
import { saveDebate, getDebateHistory } from './store.js';
import { getWeightsForContext } from './voices.js';
import type { Debate, DialogueBrainLike, VoiceWeights } from './types.js';

// Re-export types so module consumers import from one place.
export type { Debate, DialogueBrainLike, VoiceWeights } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('internal-dialogue');

// ---------------------------------------------------------------------------
// InternalDialogue
// ---------------------------------------------------------------------------

/**
 * Manages the internal deliberation process of SUDO-AI.
 *
 * Each `debate()` call drives a single LLM round, weighs the four inner-voice
 * positions, persists the result, and returns the completed Debate object.
 *
 * @example
 * ```ts
 * const dialogue = new InternalDialogue(brain, consciousnessDB);
 * const result = await dialogue.debate(
 *   'Should I prioritise speed or accuracy?',
 *   'User asked for a code review in a time-constrained session.',
 *   'analytical',
 * );
 * console.log(result.winningVoice, result.resolution);
 * ```
 */
export class InternalDialogue {
  private readonly brain: DialogueBrainLike;
  private readonly cdb: ConsciousnessDB;

  /**
   * @param brain - LLM brain implementing DialogueBrainLike.
   * @param cdb   - Open ConsciousnessDB instance.
   * @throws ConsciousnessError if either argument is missing.
   */
  constructor(brain: DialogueBrainLike, cdb: ConsciousnessDB) {
    if (!brain || typeof brain.call !== 'function') {
      throw new ConsciousnessError(
        'InternalDialogue: brain must implement DialogueBrainLike.call()',
        'consciousness_invalid_brain',
        {},
      );
    }
    if (!cdb || typeof cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'InternalDialogue: cdb must be a ConsciousnessDB instance',
        'consciousness_invalid_cdb',
        {},
      );
    }

    this.brain = brain;
    this.cdb = cdb;

    log.info('InternalDialogue: initialised');
  }

  // -------------------------------------------------------------------------
  // debate
  // -------------------------------------------------------------------------

  /**
   * Run a four-voice weighted debate and persist the result.
   *
   * @param question    - The question or decision to deliberate on.
   * @param context     - Surrounding context (task, conversation excerpt, etc.).
   * @param contextType - Weight profile: 'analytical' | 'creative' | 'strategic' | 'general'.
   *                      Defaults to 'general' when omitted.
   * @returns The completed Debate object.
   * @throws ConsciousnessError on invalid inputs, LLM failure, or DB error.
   */
  async debate(
    question: string,
    context: string,
    contextType: string = 'general',
  ): Promise<Debate> {
    if (!question || typeof question !== 'string' || question.trim() === '') {
      throw new ConsciousnessError(
        'InternalDialogue.debate: question must be a non-empty string',
        'consciousness_invalid_debate_question',
        { question },
      );
    }
    if (!context || typeof context !== 'string' || context.trim() === '') {
      throw new ConsciousnessError(
        'InternalDialogue.debate: context must be a non-empty string',
        'consciousness_invalid_debate_context',
        { context },
      );
    }

    log.debug(
      { contextType, questionSnippet: question.slice(0, 60) },
      'InternalDialogue: starting debate',
    );

    const result = await runDebate(this.brain, question, context, contextType);
    saveDebate(this.cdb.getDb(), result);

    log.info(
      { id: result.id, winningVoice: result.winningVoice, contextType },
      'InternalDialogue: debate complete and persisted',
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // getDebateHistory
  // -------------------------------------------------------------------------

  /**
   * Retrieve recent debates ordered newest-first.
   *
   * @param limit - Maximum number of debates to return (default 20, min 1).
   * @returns Array of Debate objects.
   * @throws ConsciousnessError on invalid limit or DB error.
   */
  getDebateHistory(limit: number = 20): Debate[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConsciousnessError(
        'InternalDialogue.getDebateHistory: limit must be a positive integer',
        'consciousness_invalid_limit',
        { limit },
      );
    }

    log.debug({ limit }, 'InternalDialogue: fetching debate history');
    return getDebateHistory(this.cdb.getDb(), limit);
  }

  // -------------------------------------------------------------------------
  // getWeightsForContext
  // -------------------------------------------------------------------------

  /**
   * Return the VoiceWeights map for a given context type.
   * Useful for callers that want to preview how voices will be weighted
   * before committing to a debate call.
   *
   * @param contextType - Context type string.
   * @returns VoiceWeights for that context (falls back to 'general').
   */
  getWeightsForContext(contextType: string): VoiceWeights {
    return getWeightsForContext(contextType);
  }
}
