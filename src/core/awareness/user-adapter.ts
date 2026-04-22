/**
 * @file user-adapter.ts
 * @description Upgrade 67 — User Style Adaptation.
 *
 * Builds a live profile of the user's preferences by observing message
 * patterns and tool usage, then exposes a prompt-hint string so the Brain
 * can adapt its tone and verbosity automatically.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('awareness:user-adapter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfile {
  preferredLanguage: string;
  codingStyle: 'verbose' | 'concise' | 'balanced';
  responseLength: 'short' | 'medium' | 'detailed';
  technicalLevel: 'beginner' | 'intermediate' | 'expert';
  commonTools: string[];
  preferredModels: string[];
  timezone?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const MAX_COMMON_TOOLS = 20;

const DEFAULT_PROFILE: Readonly<UserProfile> = Object.freeze({
  preferredLanguage: 'en',
  codingStyle:       'balanced',
  responseLength:    'medium',
  technicalLevel:    'expert',
  commonTools:       [],
  preferredModels:   [],
  updatedAt:         new Date().toISOString(),
});

let profile: UserProfile = { ...DEFAULT_PROFILE, commonTools: [], preferredModels: [] };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a partial update to the user profile.
 * Only supplied keys are changed; the rest are preserved.
 */
export function updateProfile(updates: Partial<UserProfile>): UserProfile {
  if (!updates || typeof updates !== 'object') throw new TypeError('updates must be an object');

  profile = { ...profile, ...updates, updatedAt: new Date().toISOString() };
  log.info({ keys: Object.keys(updates) }, 'User profile updated');
  return { ...profile };
}

/** Return a snapshot of the current profile (safe to mutate). */
export function getProfile(): UserProfile {
  return { ...profile, commonTools: [...profile.commonTools], preferredModels: [...profile.preferredModels] };
}

/**
 * Learn from a single user interaction.
 *
 * - Adds newly seen tools to `commonTools` (capped at MAX_COMMON_TOOLS).
 * - Adjusts `responseLength` heuristically based on message length.
 */
export function learnFromInteraction(message: string, toolsUsed: string[]): void {
  if (typeof message !== 'string') throw new TypeError('message must be a string');
  if (!Array.isArray(toolsUsed))   throw new TypeError('toolsUsed must be an array');

  // Track common tools
  for (const tool of toolsUsed) {
    if (!profile.commonTools.includes(tool)) {
      profile.commonTools.push(tool);
      if (profile.commonTools.length > MAX_COMMON_TOOLS) profile.commonTools.shift();
    }
  }

  // Infer response-length preference from message length
  if (message.length < 50)       profile.responseLength = 'short';
  else if (message.length > 300) profile.responseLength = 'detailed';
  else                           profile.responseLength = 'medium';

  profile.updatedAt = new Date().toISOString();
  log.debug({ msgLen: message.length, toolCount: toolsUsed.length }, 'Learned from interaction');
}

/**
 * Returns a one-line hint injected into the system prompt so the LLM adapts
 * to the detected user style.
 */
export function toPromptHint(): string {
  return (
    `User profile: ${profile.technicalLevel} level, prefers ` +
    `${profile.responseLength} ${profile.codingStyle} responses.`
  );
}

/** Reset the profile to factory defaults (useful for testing). */
export function resetProfile(): void {
  profile = { ...DEFAULT_PROFILE, commonTools: [], preferredModels: [] };
}
