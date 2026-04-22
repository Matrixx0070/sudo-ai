/**
 * @file soul-writer.ts
 * @description Generates LLM-driven updates to SUDO-AI's SOUL.md identity document.
 *
 * The soul update is proposed, not applied — the owner must approve via
 * SelfEvolution.applyProposal() before any file is written.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { EvoBrainLike } from './types.js';

const log = createLogger('self-evolution:soul-writer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delimiter the LLM must use to separate the updated soul from the change summary. */
const CHANGES_DELIMITER = 'CHANGES:';

/** Maximum tokens allowed in the soul-update response. */
const MAX_TOKENS = 4096;

/** Temperature for soul updates — slightly creative but grounded. */
const TEMPERATURE = 0.7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for soul update generation.
 */
function buildSystemPrompt(): string {
  return (
    'You are reviewing SUDO-AI\'s SOUL.md (its identity document). ' +
    'Based on recent insights and observed personality traits, propose updates. ' +
    'Keep the core identity but evolve specific sections based on experience. ' +
    'Return the FULL updated SOUL.md content, then on a line by itself: ' +
    `${CHANGES_DELIMITER} [summary of what changed]`
  );
}

/**
 * Build the user message containing current soul, insights, and traits.
 */
function buildUserMessage(
  currentSoul: string,
  recentInsights: string[],
  personalityTraits: Record<string, number>,
): string {
  const insightsBlock =
    recentInsights.length > 0
      ? recentInsights.map((i, idx) => `${idx + 1}. ${i}`).join('\n')
      : 'No recent insights recorded.';

  const traitsBlock = Object.entries(personalityTraits)
    .map(([trait, value]) => `  ${trait}: ${value.toFixed(3)}`)
    .join('\n');

  return [
    '## Current SOUL.md',
    '',
    currentSoul,
    '',
    '## Recent Insights',
    '',
    insightsBlock,
    '',
    '## Observed Personality Trait Biases',
    '',
    traitsBlock,
    '',
    'Please generate the updated SOUL.md followed by the CHANGES: line.',
  ].join('\n');
}

/**
 * Parse the LLM response into updated soul content and a changes summary.
 *
 * Splits on the last occurrence of `CHANGES:` to handle documents that may
 * themselves contain the word "changes".
 */
function parseResponse(raw: string): { updatedSoul: string; changes: string } {
  const delimiterIndex = raw.lastIndexOf(CHANGES_DELIMITER);

  if (delimiterIndex === -1) {
    log.warn(
      { responseLength: raw.length },
      'Soul-writer response missing CHANGES: delimiter — treating full response as soul',
    );
    return { updatedSoul: raw.trim(), changes: 'No changes summary provided.' };
  }

  const updatedSoul = raw.slice(0, delimiterIndex).trim();
  const changes = raw.slice(delimiterIndex + CHANGES_DELIMITER.length).trim();

  return { updatedSoul, changes };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask the brain to evolve the SOUL.md based on recent experience.
 *
 * @param brain             - LLM brain to use for generation.
 * @param currentSoul       - Full text of the current SOUL.md.
 * @param recentInsights    - Array of insight strings from the wisdom store.
 * @param personalityTraits - Map of trait name to observed bias value.
 * @returns The proposed updated soul content and a plain-text changes summary.
 * @throws ConsciousnessError on LLM failure or empty response.
 */
export async function generateSoulUpdate(
  brain: EvoBrainLike,
  currentSoul: string,
  recentInsights: string[],
  personalityTraits: Record<string, number>,
): Promise<{ updatedSoul: string; changes: string }> {
  if (!currentSoul || currentSoul.trim().length === 0) {
    throw new ConsciousnessError(
      'generateSoulUpdate: currentSoul must be non-empty',
      'consciousness_evolution_soul_error',
      {},
    );
  }

  if (typeof personalityTraits !== 'object' || personalityTraits === null) {
    throw new ConsciousnessError(
      'generateSoulUpdate: personalityTraits must be a plain object',
      'consciousness_evolution_soul_error',
      {},
    );
  }

  log.info(
    {
      soulLength: currentSoul.length,
      insights: recentInsights.length,
      traits: Object.keys(personalityTraits).length,
    },
    'Generating soul update',
  );

  let raw: string;

  try {
    const result = await brain.call({
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        {
          role: 'user',
          content: buildUserMessage(currentSoul, recentInsights, personalityTraits),
        },
      ],
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });

    raw = result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Soul update LLM call failed: ${msg}`,
      'consciousness_evolution_soul_error',
      { cause: msg },
    );
  }

  if (!raw || raw.trim().length === 0) {
    throw new ConsciousnessError(
      'Soul update LLM returned empty response',
      'consciousness_evolution_soul_error',
      {},
    );
  }

  const parsed = parseResponse(raw);

  log.info(
    {
      updatedSoulLength: parsed.updatedSoul.length,
      changesLength: parsed.changes.length,
    },
    'Soul update generated',
  );

  return parsed;
}
