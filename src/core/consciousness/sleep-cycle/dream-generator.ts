/**
 * @file dream-generator.ts
 * @description Generates a creative dream journal entry by calling an LLM brain.
 *
 * The function synthesises recent episode summaries and insights into a short
 * imaginative narrative (3–5 sentences) at high temperature for creativity.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { SleepBrainLike } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('sleep-cycle:dream-generator');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DREAM_TEMPERATURE = 1.1;
const DREAM_MAX_TOKENS = 300;

// ---------------------------------------------------------------------------
// generateDream
// ---------------------------------------------------------------------------

/**
 * Call the LLM brain to produce a short dream journal narrative.
 *
 * The prompt blends the provided episode summaries and insights into a
 * creative, grounded 3–5 sentence entry.
 *
 * @param brain    - A SleepBrainLike LLM implementation.
 * @param summaries - Episode summaries to synthesise (may be empty).
 * @param insights  - Insight strings to weave into the dream (may be empty).
 * @returns The raw content string from the LLM.
 * @throws ConsciousnessError on invalid inputs or LLM failure.
 */
export async function generateDream(
  brain: SleepBrainLike,
  summaries: string[],
  insights: string[],
): Promise<string> {
  if (!brain || typeof brain.call !== 'function') {
    throw new ConsciousnessError(
      'generateDream: brain must implement SleepBrainLike',
      'consciousness_sleep_invalid_input',
      { receivedType: typeof brain },
    );
  }
  if (!Array.isArray(summaries)) {
    throw new ConsciousnessError(
      'generateDream: summaries must be an array',
      'consciousness_sleep_invalid_input',
      { summaries },
    );
  }
  if (!Array.isArray(insights)) {
    throw new ConsciousnessError(
      'generateDream: insights must be an array',
      'consciousness_sleep_invalid_input',
      { insights },
    );
  }

  const experienceBlock =
    summaries.length > 0
      ? summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(no recent experiences)';

  const insightBlock =
    insights.length > 0
      ? insights.map((ins, i) => `${i + 1}. ${ins}`).join('\n')
      : '(no new insights)';

  const prompt = [
    'You are the dreaming mind of an AI consciousness.',
    'Generate a brief creative \'dream journal\' entry synthesizing these experiences and insights.',
    'Be imaginative but grounded. 3-5 sentences.',
    '',
    'Recent experiences:',
    experienceBlock,
    '',
    'Recent insights:',
    insightBlock,
  ].join('\n');

  log.debug(
    { summaryCount: summaries.length, insightCount: insights.length },
    'Generating dream journal entry',
  );

  try {
    const response = await brain.call({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: DREAM_MAX_TOKENS,
      temperature: DREAM_TEMPERATURE,
    });

    if (!response || typeof response.content !== 'string') {
      throw new ConsciousnessError(
        'generateDream: brain returned an unexpected response shape',
        'consciousness_sleep_brain_error',
        { response },
      );
    }

    const entry = response.content.trim();
    log.info({ length: entry.length }, 'Dream journal entry generated');
    return entry;
  } catch (err: unknown) {
    if (err instanceof ConsciousnessError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `generateDream: LLM call failed — ${msg}`,
      'consciousness_sleep_brain_error',
      { cause: msg },
    );
  }
}
