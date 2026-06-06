/**
 * @file store.ts
 * @description SQLite persistence layer for the theory-of-mind subsystem.
 *
 * All operations are synchronous (better-sqlite3).
 * JSON fields (traits, preferences, knownTriggers, knownDelights) are
 * serialised/deserialised transparently by the row converters.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { UserModel } from '../types.js';
import type { InteractionRecord } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('theory-of-mind:store');

// ---------------------------------------------------------------------------
// Row shape returned by SQLite for user_models
// ---------------------------------------------------------------------------

interface UserModelRow {
  user_id: string;
  traits: string;
  preferences: string;
  communication_style: string;
  trust_level: number;
  known_triggers: string;
  known_delights: string;
  last_interaction: string;
  interaction_count: number;
}

// ---------------------------------------------------------------------------
// Row shape returned by SQLite for user_interaction_log
// ---------------------------------------------------------------------------

interface InteractionRow {
  user_id: string;
  message: string;
  response: string;
  outcome: string;
  inferred_mood: string | null;
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToUserModel(row: UserModelRow): UserModel {
  return {
    userId: row.user_id,
    traits: safeParseArray(row.traits),
    preferences: safeParseArray(row.preferences),
    communicationStyle: row.communication_style,
    trustLevel: row.trust_level,
    knownTriggers: safeParseArray(row.known_triggers),
    knownDelights: safeParseArray(row.known_delights),
    lastInteraction: row.last_interaction,
    interactionCount: row.interaction_count,
  };
}

function rowToInteractionRecord(row: InteractionRow): InteractionRecord {
  return {
    userId: row.user_id,
    message: row.message,
    response: row.response,
    outcome: row.outcome as InteractionRecord['outcome'],
    inferredMood: row.inferred_mood ?? undefined,
  };
}

function safeParseArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public store functions
// ---------------------------------------------------------------------------

/**
 * Insert or replace a full UserModel record in user_models.
 * All array fields are JSON-serialised before storage.
 *
 * @throws ConsciousnessError on DB write failure.
 */
export function saveUserModel(db: Database.Database, model: UserModel): void {
  if (!model.userId || typeof model.userId !== 'string') {
    throw new ConsciousnessError(
      'saveUserModel: userId must be a non-empty string',
      'consciousness_tom_invalid_user_id',
      { userId: model.userId },
    );
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO user_models
        (user_id, traits, preferences, communication_style, trust_level,
         known_triggers, known_delights, last_interaction, interaction_count,
         created_at, updated_at)
      VALUES
        (@userId, @traits, @preferences, @communicationStyle, @trustLevel,
         @knownTriggers, @knownDelights, @lastInteraction, @interactionCount,
         COALESCE(
           (SELECT created_at FROM user_models WHERE user_id = @userId),
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run({
      userId: model.userId,
      traits: JSON.stringify(model.traits),
      preferences: JSON.stringify(model.preferences),
      communicationStyle: model.communicationStyle,
      trustLevel: model.trustLevel,
      knownTriggers: JSON.stringify(model.knownTriggers),
      knownDelights: JSON.stringify(model.knownDelights),
      lastInteraction: model.lastInteraction,
      interactionCount: model.interactionCount,
    });

    log.debug({ userId: model.userId }, 'User model saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveUserModel failed: ${msg}`,
      'consciousness_tom_save_failed',
      { userId: model.userId, cause: msg },
    );
  }
}

/**
 * Retrieve a UserModel by userId. Returns null when not found.
 */
export function getUserModel(db: Database.Database, userId: string): UserModel | null {
  if (!userId) return null;

  const row = db
    .prepare('SELECT * FROM user_models WHERE user_id = ?')
    .get(userId) as UserModelRow | undefined;

  if (!row) {
    log.debug({ userId }, 'User model not found');
    return null;
  }

  return rowToUserModel(row);
}

/**
 * Return all stored UserModel records.
 */
export function getAllUsers(db: Database.Database): UserModel[] {
  const rows = db
    .prepare('SELECT * FROM user_models ORDER BY last_interaction DESC')
    .all() as UserModelRow[];

  return rows.map(rowToUserModel);
}

/**
 * Adjust trust_level by `delta` and clamp the result to [0, 1].
 *
 * @throws ConsciousnessError if the userId does not exist.
 */
export function updateTrustLevel(db: Database.Database, userId: string, delta: number): void {
  if (!userId) {
    throw new ConsciousnessError(
      'updateTrustLevel: userId is required',
      'consciousness_tom_invalid_user_id',
      {},
    );
  }

  try {
    db.prepare(`
      UPDATE user_models
         SET trust_level = MAX(0.0, MIN(1.0, trust_level + @delta)),
             updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = @userId
    `).run({ delta, userId });

    log.debug({ userId, delta }, 'Trust level updated');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `updateTrustLevel failed: ${msg}`,
      'consciousness_tom_trust_update_failed',
      { userId, delta, cause: msg },
    );
  }
}

/**
 * Increment interaction_count and update last_interaction to now.
 */
export function incrementInteraction(db: Database.Database, userId: string): void {
  if (!userId) return;

  db.prepare(`
    UPDATE user_models
       SET interaction_count = interaction_count + 1,
           last_interaction  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?
  `).run(userId);

  log.debug({ userId }, 'Interaction count incremented');
}

/**
 * Insert an interaction record into user_interaction_log.
 */
export function logInteraction(db: Database.Database, record: InteractionRecord): void {
  if (!record.userId || !record.message) {
    throw new ConsciousnessError(
      'logInteraction: userId and message are required',
      'consciousness_tom_invalid_interaction',
      { userId: record.userId },
    );
  }

  try {
    db.prepare(`
      INSERT INTO user_interaction_log (user_id, message, response, outcome, inferred_mood)
      VALUES (@userId, @message, @response, @outcome, @inferredMood)
    `).run({
      userId: record.userId,
      message: record.message,
      response: record.response,
      outcome: record.outcome,
      inferredMood: record.inferredMood ?? null,
    });

    log.debug({ userId: record.userId, outcome: record.outcome }, 'Interaction logged');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `logInteraction failed: ${msg}`,
      'consciousness_tom_log_failed',
      { userId: record.userId, cause: msg },
    );
  }
}

/**
 * Return the most recent `count` interactions for a user, newest first.
 */
export function getInteractionHistory(
  db: Database.Database,
  userId: string,
  count: number,
): InteractionRecord[] {
  if (!userId || count < 1) return [];

  const rows = db
    .prepare(`
      SELECT user_id, message, response, outcome, inferred_mood
        FROM user_interaction_log
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?
    `)
    .all(userId, count) as InteractionRow[];

  return rows.map(rowToInteractionRecord);
}
