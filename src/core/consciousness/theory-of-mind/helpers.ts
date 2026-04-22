/**
 * @file helpers.ts
 * @description Pure helper functions for the theory-of-mind subsystem.
 *
 * Contains: default model factory, array utilities, communication-style
 * detection, trigger/delight pattern matching, and rule-based prediction.
 * No DB or LLM dependencies — all functions are pure or trivially testable.
 */

import type { UserModel } from '../types.js';
import type { UserPrediction } from './types.js';

// ---------------------------------------------------------------------------
// Default trust
// ---------------------------------------------------------------------------

export const DEFAULT_TRUST = 0.5;
export const TRUST_POSITIVE_DELTA = 0.02;
export const TRUST_NEGATIVE_DELTA = -0.05;

// ---------------------------------------------------------------------------
// Default model factory
// ---------------------------------------------------------------------------

/**
 * Build an empty UserModel skeleton for a first-time user.
 * Trust starts at DEFAULT_TRUST (0.5) — neutral, not earned but not adversarial.
 */
export function createDefaultModel(userId: string): UserModel {
  return {
    userId,
    traits: [],
    preferences: [],
    communicationStyle: 'standard',
    trustLevel: DEFAULT_TRUST,
    knownTriggers: [],
    knownDelights: [],
    lastInteraction: new Date().toISOString(),
    interactionCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Array utility
// ---------------------------------------------------------------------------

/**
 * Add `value` to `arr` if not already present (mutates in place).
 * Returns the same array for chaining.
 */
export function addUnique(arr: string[], value: string): string[] {
  if (!arr.includes(value)) arr.push(value);
  return arr;
}

// ---------------------------------------------------------------------------
// Communication style detection
// ---------------------------------------------------------------------------

/**
 * Derive a communication style label from a sample of recent messages.
 * Rules are applied in priority order; first match wins.
 *
 * - terse      : avg message length < 20 chars
 * - detailed   : avg message length > 200 chars
 * - inquisitive: more than 50% of messages contain '?'
 * - directive  : more than 40% of messages begin with a command verb
 * - standard   : default fallback
 */
export function detectCommunicationStyle(messages: string[]): string {
  if (messages.length === 0) return 'standard';

  const avgLen = messages.reduce((sum, m) => sum + m.length, 0) / messages.length;

  const commandPrefixes = [
    'do ', 'run ', 'make ', 'create ', 'delete ',
    'show ', 'get ', 'set ', 'list ', 'find ',
  ];

  const questionCount = messages.filter((m) => m.includes('?')).length;
  const commandCount = messages.filter((m) => {
    const lower = m.toLowerCase().trimStart();
    return commandPrefixes.some((p) => lower.startsWith(p));
  }).length;

  const questionRatio = questionCount / messages.length;
  const commandRatio = commandCount / messages.length;

  if (avgLen < 20) return 'terse';
  if (avgLen > 200) return 'detailed';
  if (questionRatio > 0.5) return 'inquisitive';
  if (commandRatio > 0.4) return 'directive';
  return 'standard';
}

// ---------------------------------------------------------------------------
// Trigger / delight detection
// ---------------------------------------------------------------------------

/**
 * Return true when the message contains frustration signals:
 * - Two or more exclamation marks
 * - Double question mark (??)
 * - More than 40% of words are ALL-CAPS (when there are at least 2 words)
 */
export function detectFrustration(message: string): boolean {
  const hasExclamationExcess = (message.match(/!/g) ?? []).length >= 2;
  const hasDoubleQuestion = message.includes('??');

  const words = message.split(/\s+/).filter(Boolean);
  const upperCount = words.filter((w) => w === w.toUpperCase() && w.length > 2).length;
  const hasCaps = words.length > 1 && upperCount / words.length > 0.4;

  return hasExclamationExcess || hasDoubleQuestion || hasCaps;
}

/**
 * Return true when the message contains explicit positive acknowledgement.
 */
export function detectPositiveSentiment(message: string): boolean {
  const lower = message.toLowerCase();
  const positivePatterns = [
    'thanks', 'thank you', 'great', 'perfect',
    'awesome', 'excellent', 'well done', 'nice work',
  ];
  return positivePatterns.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Rule-based prediction fallback
// ---------------------------------------------------------------------------

/**
 * Derive a UserPrediction from text patterns alone (no LLM required).
 * Used when no brain is injected or when the brain call fails.
 */
export function rulePrediction(message: string): UserPrediction {
  const lower = message.toLowerCase();
  const hasQuestion = message.includes('?');
  const hasExclamation = message.includes('!');
  const hasDoubleQuestion = message.includes('??');

  const words = message.split(/\s+/).filter(Boolean);
  const upperCount = words.filter((w) => w === w.toUpperCase() && w.length > 2).length;
  const capsDominant = words.length > 1 && upperCount / words.length > 0.4;

  if (capsDominant || hasDoubleQuestion) {
    return { mood: 'frustrated', intent: 'demand resolution', urgency: 0.85 };
  }
  if (hasExclamation && !hasQuestion) {
    return { mood: 'assertive', intent: 'emphasise action', urgency: 0.65 };
  }
  if (hasQuestion) {
    return { mood: 'curious', intent: 'seek information', urgency: 0.3 };
  }
  if (lower.includes('help') || lower.includes('stuck') || lower.includes('error')) {
    return { mood: 'concerned', intent: 'request assistance', urgency: 0.6 };
  }

  return { mood: 'neutral', intent: 'general interaction', urgency: 0.2 };
}
