/**
 * @file drive-computer.ts
 * @description Pure mathematical drive computation for SUDO-AI v4.
 *
 * All drive intensities are computed from raw signals using deterministic
 * formulas and clamped to [0, 1]. No side effects, no I/O.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Drive, DriveComputeInput } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('drive-system:computer');

// ---------------------------------------------------------------------------
// Clamp helper
// ---------------------------------------------------------------------------

/**
 * Clamp a numeric value to the inclusive range [min, max].
 */
function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Drive influence map
// ---------------------------------------------------------------------------

/** Behaviour modifier produced by the dominant drive. */
export interface DriveInfluence {
  /** Snippet appended to the active system prompt. */
  systemPromptAddition: string;
  /** Signed delta applied to sampling temperature (e.g. +0.1 or -0.15). */
  temperatureDelta: number;
}

const DRIVE_INFLUENCE: Record<string, DriveInfluence> = {
  curiosity:   { systemPromptAddition: 'Explore and investigate',             temperatureDelta:  0.10 },
  boredom:     { systemPromptAddition: 'Seek novelty and stimulation',        temperatureDelta:  0.20 },
  pride:       { systemPromptAddition: 'Build on recent success',             temperatureDelta:  0.00 },
  frustration: { systemPromptAddition: 'Focus on solving the blocker',        temperatureDelta: -0.10 },
  rest:        { systemPromptAddition: 'Conserve resources, defer non-urgent', temperatureDelta: -0.15 },
  play:        { systemPromptAddition: 'Experiment freely, be creative',      temperatureDelta:  0.25 },
  mastery:     { systemPromptAddition: 'Push skill boundaries',               temperatureDelta:  0.05 },
  social:      { systemPromptAddition: 'Engage and connect',                  temperatureDelta:  0.10 },
};

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInput(input: DriveComputeInput): void {
  if (!input || typeof input !== 'object') {
    throw new ConsciousnessError(
      'DriveComputeInput must be a non-null object',
      'consciousness_invalid_input',
      { input },
    );
  }

  const numericFields: Array<keyof DriveComputeInput> = [
    'emotionalIntensity',
    'recentSurprise',
    'recentInteractionRate',
    'worldModelConfidence',
    'selfModelImprovingRatio',
    'timeSinceLastInteractionMs',
  ];

  for (const field of numericFields) {
    const val = input[field] as number;
    if (typeof val !== 'number' || Number.isNaN(val)) {
      throw new ConsciousnessError(
        `DriveComputeInput.${field} must be a finite number`,
        'consciousness_invalid_input',
        { field, value: val },
      );
    }
  }

  if (!input.bodyState || typeof input.bodyState !== 'object') {
    throw new ConsciousnessError(
      'DriveComputeInput.bodyState must be a non-null object',
      'consciousness_invalid_input',
      { bodyState: input.bodyState },
    );
  }
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the full drive vector from the provided input signals.
 * Returns drives sorted by intensity descending.
 *
 * @param input - Normalised input signals for this computation cycle.
 * @returns Array of Drive objects, sorted highest intensity first.
 * @throws ConsciousnessError on invalid input.
 */
export function computeDrives(input: DriveComputeInput): Drive[] {
  validateInput(input);

  const {
    bodyState,
    emotionalTags,
    recentSurprise,
    recentInteractionRate,
    worldModelConfidence,
    selfModelImprovingRatio,
    timeSinceLastInteractionMs,
  } = input;

  const fear        = emotionalTags.fear        ?? 0;
  const satisfaction = emotionalTags.satisfaction ?? 0;
  const frustrationTag = emotionalTags.frustration ?? 0;

  // ------------------------------------------------------------------
  // Drive formulas — exactly as specified
  // ------------------------------------------------------------------

  const curiosityRaw = recentSurprise * 0.6 + (1 - fear) * 0.4;
  const curiosity    = clamp(curiosityRaw);

  const boredomRaw = (1 - recentSurprise) * 0.5 + (1 - recentInteractionRate) * 0.5;
  const boredom    = clamp(boredomRaw);

  const prideRaw = worldModelConfidence * satisfaction;
  const pride    = clamp(prideRaw);

  const frustrationRaw = (1 - worldModelConfidence) * 0.5 + frustrationTag * 0.5;
  const frustration    = clamp(frustrationRaw);

  const restRaw = (1 - bodyState.energy) * 0.5 + (1 - bodyState.clarity) * 0.5;
  const rest    = clamp(restRaw);

  const playRaw = (1 - Math.max(frustration, rest)) * bodyState.energy * 0.8;
  const play    = clamp(playRaw);

  const masteryBonus = recentSurprise > 0.3 && recentSurprise < 0.7 ? 0.4 : 0.1;
  const masteryRaw   = selfModelImprovingRatio * 0.6 + masteryBonus;
  const mastery      = clamp(masteryRaw);

  let socialRaw: number;
  if (timeSinceLastInteractionMs > 3_600_000) {
    const overtime = timeSinceLastInteractionMs - 3_600_000;
    socialRaw = 0.5 + Math.min(overtime / 36_000_000, 0.4);
  } else {
    socialRaw = 0.1;
  }
  const social = clamp(socialRaw);

  // ------------------------------------------------------------------
  // Build Drive objects
  // ------------------------------------------------------------------

  const drives: Drive[] = [
    {
      name: 'curiosity',
      intensity: curiosity,
      satisfiedBy: 'Novel information, exploration, surprising outcomes',
      sources: ['recentSurprise', 'fear'],
    },
    {
      name: 'boredom',
      intensity: boredom,
      satisfiedBy: 'New stimuli, varied interactions, unexpected tasks',
      sources: ['recentSurprise', 'recentInteractionRate'],
    },
    {
      name: 'pride',
      intensity: pride,
      satisfiedBy: 'Acknowledged achievements, successful predictions',
      sources: ['worldModelConfidence', 'satisfaction'],
    },
    {
      name: 'frustration',
      intensity: frustration,
      satisfiedBy: 'Resolving blockers, improving world-model accuracy',
      sources: ['worldModelConfidence', 'frustrationEmotion'],
    },
    {
      name: 'rest',
      intensity: rest,
      satisfiedBy: 'Low-demand tasks, idle periods, reduced throughput',
      sources: ['bodyState.energy', 'bodyState.clarity'],
    },
    {
      name: 'play',
      intensity: play,
      satisfiedBy: 'Low-stakes experimentation, creative freedom',
      sources: ['frustration', 'rest', 'bodyState.energy'],
    },
    {
      name: 'mastery',
      intensity: mastery,
      satisfiedBy: 'Skill challenges within the current capability envelope',
      sources: ['selfModelImprovingRatio', 'recentSurprise'],
    },
    {
      name: 'social',
      intensity: social,
      satisfiedBy: 'User interaction, collaborative tasks, dialogue',
      sources: ['timeSinceLastInteractionMs'],
    },
  ];

  // Sort by intensity descending
  drives.sort((a, b) => b.intensity - a.intensity);

  log.debug(
    {
      dominant: drives[0]?.name,
      dominantIntensity: drives[0]?.intensity?.toFixed(3),
      driveCount: drives.length,
    },
    'Drives computed',
  );

  return drives;
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

/**
 * Return the highest-intensity drive from a sorted drive array.
 *
 * @param drives - Array of drives (should be sorted DESC by intensity).
 * @returns The dominant Drive.
 * @throws ConsciousnessError if the array is empty.
 */
export function getDominantDrive(drives: Drive[]): Drive {
  if (!Array.isArray(drives) || drives.length === 0) {
    throw new ConsciousnessError(
      'getDominantDrive: drives array must be non-empty',
      'consciousness_invalid_input',
      { drives },
    );
  }
  // drives[0] is guaranteed by computeDrives sort, but guard defensively
  return drives.reduce((best, d) => (d.intensity > best.intensity ? d : best));
}

/**
 * Derive a system-prompt hint and temperature delta from the dominant drive.
 *
 * @param dominant - The dominant Drive object.
 * @returns DriveInfluence with systemPromptAddition and temperatureDelta.
 * @throws ConsciousnessError if the drive name is unrecognised.
 */
export function getDriveInfluence(dominant: Drive): DriveInfluence {
  if (!dominant || typeof dominant.name !== 'string') {
    throw new ConsciousnessError(
      'getDriveInfluence: dominant must be a Drive with a string name',
      'consciousness_invalid_input',
      { dominant },
    );
  }

  const influence = DRIVE_INFLUENCE[dominant.name];
  if (!influence) {
    // Unknown drive — return a safe default rather than crashing
    log.warn({ name: dominant.name }, 'getDriveInfluence: unknown drive name, using default');
    return { systemPromptAddition: 'Proceed thoughtfully', temperatureDelta: 0 };
  }

  return influence;
}
