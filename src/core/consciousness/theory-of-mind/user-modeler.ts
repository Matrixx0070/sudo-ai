/**
 * @file user-modeler.ts
 * @description TheoryOfMind — builds and maintains per-user mental models.
 *
 * Tracks communication style, trust, triggers, delights, and relationship
 * stage from observed interactions. Supports LLM-assisted mood inference via
 * an optional MindReaderBrainLike dependency.
 *
 * Pure helpers live in helpers.ts; DB operations live in store.ts.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { UserModel } from '../types.js';
import type { InteractionRecord, MindReaderBrainLike, UserPrediction } from './types.js';
import {
  getAllUsers,
  getInteractionHistory,
  getUserModel,
  incrementInteraction,
  logInteraction,
  saveUserModel,
  updateTrustLevel,
} from './store.js';
import {
  addUnique,
  createDefaultModel,
  detectCommunicationStyle,
  detectFrustration,
  detectPositiveSentiment,
  rulePrediction,
  TRUST_NEGATIVE_DELTA,
  TRUST_POSITIVE_DELTA,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('theory-of-mind');

// ---------------------------------------------------------------------------
// Style instructions map
// ---------------------------------------------------------------------------

const STYLE_INSTRUCTIONS: Record<string, string> = {
  terse: 'Keep responses short and direct. No filler.',
  detailed: 'Provide thorough explanations with examples.',
  directive: 'Execute immediately, report results. Minimal discussion.',
  inquisitive: 'Explain reasoning. Anticipate follow-up questions.',
  standard: 'Use a clear, balanced tone.',
};

// ---------------------------------------------------------------------------
// TheoryOfMind
// ---------------------------------------------------------------------------

/**
 * Builds and maintains a mental model of each user from observed interactions.
 *
 * Persists models to SQLite via the store layer. Supports optional LLM-based
 * mood inference through a MindReaderBrainLike dependency.
 */
export class TheoryOfMind {
  private readonly db: Database.Database;
  private readonly brain?: MindReaderBrainLike;

  /**
   * @param cdb   - Open ConsciousnessDB instance.
   * @param brain - Optional LLM brain for mood inference. Omit for rule-based only.
   */
  constructor(cdb: ConsciousnessDB, brain?: MindReaderBrainLike) {
    this.db = cdb.getDb();
    this.brain = brain;
    log.info('TheoryOfMind initialised');
  }

  // -------------------------------------------------------------------------
  // updateUserModel
  // -------------------------------------------------------------------------

  /**
   * Process one interaction and update the persisted user model.
   *
   * Steps:
   * 1. Get or create a UserModel for this userId.
   * 2. Log the raw interaction.
   * 3. Increment interaction counter and last_interaction timestamp.
   * 4. Adjust trust level based on outcome.
   * 5. Detect triggers and delights from the message.
   * 6. Recalculate communication style from recent history.
   * 7. Persist the updated model.
   */
  async updateUserModel(userId: string, interaction: InteractionRecord): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw new ConsciousnessError(
        'updateUserModel: userId is required',
        'consciousness_tom_invalid_user_id',
        { userId },
      );
    }
    if (!interaction.message) {
      throw new ConsciousnessError(
        'updateUserModel: interaction.message is required',
        'consciousness_tom_invalid_interaction',
        { userId },
      );
    }

    log.debug({ userId, outcome: interaction.outcome }, 'Updating user model');

    // 1. Get or create
    let model: UserModel = getUserModel(this.db, userId) ?? createDefaultModel(userId);
    if (model.interactionCount === 0 && !getUserModel(this.db, userId)) {
      log.info({ userId }, 'New user model created');
    }

    // 2. Log interaction
    logInteraction(this.db, interaction);

    // 3. Increment count (DB-side); reflect in local snapshot too
    incrementInteraction(this.db, userId);
    model.interactionCount += 1;
    model.lastInteraction = new Date().toISOString();

    // 4. Trust adjustment
    if (interaction.outcome === 'positive') {
      updateTrustLevel(this.db, userId, TRUST_POSITIVE_DELTA);
      model.trustLevel = Math.min(1, model.trustLevel + TRUST_POSITIVE_DELTA);
    } else if (interaction.outcome === 'negative') {
      updateTrustLevel(this.db, userId, TRUST_NEGATIVE_DELTA);
      model.trustLevel = Math.max(0, model.trustLevel + TRUST_NEGATIVE_DELTA);
    }

    // 5. Triggers and delights
    if (detectFrustration(interaction.message)) {
      addUnique(model.knownTriggers, 'frustration_signals');
      log.debug({ userId }, 'Frustration signal detected — added to triggers');
    }
    if (detectPositiveSentiment(interaction.message)) {
      addUnique(model.knownDelights, 'positive_acknowledgement');
      log.debug({ userId }, 'Positive sentiment detected — added to delights');
    }

    // 6. Recalculate communication style from last 5 messages + current
    const history = getInteractionHistory(this.db, userId, 5);
    const recentMessages = [interaction.message, ...history.map((r) => r.message)];
    model.communicationStyle = detectCommunicationStyle(recentMessages);

    log.debug(
      { userId, style: model.communicationStyle, trust: model.trustLevel },
      'User model updated',
    );

    // 7. Persist
    saveUserModel(this.db, model);
  }

  // -------------------------------------------------------------------------
  // getUserModel
  // -------------------------------------------------------------------------

  /** Return the current UserModel for a user, or null if unknown. */
  getUserModel(userId: string): UserModel | null {
    return getUserModel(this.db, userId);
  }

  // -------------------------------------------------------------------------
  // getAllUsers
  // -------------------------------------------------------------------------

  /** Return all known UserModel records sorted by last interaction. */
  getAllUsers(): UserModel[] {
    return getAllUsers(this.db);
  }

  // -------------------------------------------------------------------------
  // getAdaptedStyle
  // -------------------------------------------------------------------------

  /**
   * Build a prompt instruction string tailored to this user's communication
   * style and trust level.
   *
   * @returns Natural-language style instructions for the response generator.
   */
  getAdaptedStyle(userId: string): string {
    const model = getUserModel(this.db, userId);
    if (!model) {
      log.warn({ userId }, 'getAdaptedStyle called for unknown user — returning defaults');
      return 'Respond helpfully using a balanced, friendly tone.';
    }

    const base = STYLE_INSTRUCTIONS[model.communicationStyle] ?? STYLE_INSTRUCTIONS['standard'];

    const trustClauses: string[] = [];
    if (model.trustLevel < 0.3) {
      trustClauses.push("Be careful and explicit. This user doesn't fully trust you yet.");
    } else if (model.trustLevel > 0.8) {
      trustClauses.push('This is a trusted relationship. Be direct, skip formalities.');
    }

    return [base, ...trustClauses].join(' ');
  }

  // -------------------------------------------------------------------------
  // predictUserState
  // -------------------------------------------------------------------------

  /**
   * Predict the user's current mood, intent, and urgency from a message.
   *
   * Uses LLM inference when a brain is available; falls back to rule-based
   * heuristics otherwise. Never throws — returns a neutral prediction on error.
   */
  async predictUserState(userId: string, currentMessage: string): Promise<UserPrediction> {
    if (!currentMessage) {
      return { mood: 'neutral', intent: 'unknown', urgency: 0 };
    }

    if (this.brain) {
      try {
        const context = getUserModel(this.db, userId);
        const historyNote = context
          ? `Known communication style: ${context.communicationStyle}. ` +
            `Trust: ${context.trustLevel.toFixed(2)}.`
          : 'No prior history with this user.';

        const systemPrompt =
          'You are a user state analyser. Given a user message, return JSON with fields: ' +
          '"mood" (string), "intent" (string), "urgency" (number 0-1). ' +
          'Return only valid JSON, no markdown.';

        const userPrompt =
          `${historyNote}\n\nUser message: "${currentMessage}"\n\n` +
          'Respond with JSON only: {"mood":"...","intent":"...","urgency":0.0}';

        const result = await this.brain.call({
          source: 'consciousness',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxTokens: 80,
          temperature: 0.2,
        });

        const parsed = JSON.parse(result.content.trim()) as UserPrediction;

        if (
          typeof parsed.mood === 'string' &&
          typeof parsed.intent === 'string' &&
          typeof parsed.urgency === 'number'
        ) {
          parsed.urgency = Math.max(0, Math.min(1, parsed.urgency));
          log.debug({ userId, mood: parsed.mood }, 'LLM mood prediction succeeded');
          return parsed;
        }

        log.warn(
          { userId, raw: result.content },
          'LLM returned unexpected prediction shape — using fallback',
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ userId, error: msg }, 'LLM mood inference failed — using rule fallback');
      }
    }

    const fallback = rulePrediction(currentMessage);
    log.debug({ userId, mood: fallback.mood }, 'Rule-based mood prediction used');
    return fallback;
  }
}
