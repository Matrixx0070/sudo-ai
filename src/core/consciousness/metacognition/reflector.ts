/**
 * @file reflector.ts
 * @description LLM-driven metacognitive reflection for the consciousness layer.
 *
 * reflect()            — Generate one reflection for a known episode.
 * runBatchReflection() — Batch-reflect over recent significant episodes.
 *
 * Both functions validate inputs, call the brain, parse structured output,
 * persist results, and log at each stage.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import type { MetaBrainLike, MetaEpisodicLike, Reflection } from './types.js';
import { saveReflection, getByEpisode } from './store.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('metacognition:reflector');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFLECT_MAX_TOKENS = 400;
const REFLECT_TEMPERATURE = 0.6;
const MIN_SIGNIFICANCE_FOR_BATCH = 0.4;
const DEFAULT_QUALITY_SCORE = 0.5;

// ---------------------------------------------------------------------------
// Question generator
// ---------------------------------------------------------------------------

/**
 * Select a reflective question based on the episode outcome.
 *
 * @param outcome - Episode outcome string (e.g. 'positive', 'negative', 'neutral').
 * @returns A reflective question appropriate to the outcome.
 */
function buildReflectionQuestion(outcome: string): string {
  const lower = outcome.toLowerCase();
  if (lower === 'positive') {
    return 'What made this work?';
  }
  if (lower === 'negative') {
    return 'What went wrong and why?';
  }
  return 'Was there a better approach?';
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the value following a labelled section marker from LLM text.
 * Accepts "LABEL:" or "LABEL :" (case-insensitive).
 *
 * @param text  - Raw LLM response string.
 * @param label - Section label (e.g. "ANALYSIS", "CONCLUSION").
 * @returns Trimmed value string, or empty string if not found.
 */
function extractSection(text: string, label: string): string {
  const pattern = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\n[A-Z]+\\s*:|$)`, 'is');
  const match = pattern.exec(text);
  return match?.[1]?.trim() ?? '';
}

/**
 * Parse the structured LLM reflection response into its component parts.
 *
 * Expected format:
 *   ANALYSIS: <2-3 sentences>
 *   CONCLUSION: <1 sentence>
 *   ACTION: <optional next step>
 *
 * @param raw - Full LLM response text.
 * @returns Parsed fields with fallbacks for missing sections.
 */
function parseReflectionResponse(raw: string): {
  analysis: string;
  conclusion: string;
  actionItem: string | null;
  qualityScore: number;
} {
  const trimmed = raw.trim();

  const analysis = extractSection(trimmed, 'ANALYSIS');
  const conclusion = extractSection(trimmed, 'CONCLUSION');
  const action = extractSection(trimmed, 'ACTION');

  // Quality heuristic: both analysis and conclusion present = higher quality
  const hasAnalysis = analysis.length > 20;
  const hasConclusion = conclusion.length > 10;
  let qualityScore = DEFAULT_QUALITY_SCORE;
  if (hasAnalysis && hasConclusion) qualityScore = 0.75;
  else if (hasAnalysis || hasConclusion) qualityScore = 0.6;

  return {
    analysis: analysis || 'No analysis available.',
    conclusion: conclusion || 'No conclusion drawn.',
    actionItem: action.length > 0 ? action : null,
    qualityScore: Math.round(qualityScore * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

/**
 * Generate and persist a single metacognitive reflection for an episode.
 *
 * @param brain          - LLM brain interface.
 * @param db             - Active better-sqlite3 Database instance.
 * @param episodeId      - ID of the subject episode.
 * @param episodeSummary - Natural-language summary of the episode.
 * @param outcome        - Episode outcome string.
 * @returns The saved Reflection record.
 * @throws ConsciousnessError on validation or LLM failure.
 */
export async function reflect(
  brain: MetaBrainLike,
  db: Database.Database,
  episodeId: string,
  episodeSummary: string,
  outcome: string,
): Promise<Reflection> {
  // Input validation
  if (!episodeId || typeof episodeId !== 'string') {
    throw new ConsciousnessError(
      'reflect: episodeId must be a non-empty string',
      'consciousness_meta_invalid_input',
      { episodeId },
    );
  }
  if (!episodeSummary || typeof episodeSummary !== 'string') {
    throw new ConsciousnessError(
      'reflect: episodeSummary must be a non-empty string',
      'consciousness_meta_invalid_input',
      { episodeId },
    );
  }
  if (!outcome || typeof outcome !== 'string') {
    throw new ConsciousnessError(
      'reflect: outcome must be a non-empty string',
      'consciousness_meta_invalid_input',
      { episodeId },
    );
  }

  const question = buildReflectionQuestion(outcome);

  log.info({ episodeId, question }, 'Starting reflection');

  const prompt =
    `Reflect on: ${episodeSummary}. ` +
    `Question: ${question} ` +
    `Provide:\nANALYSIS: (2-3 sentences examining reasoning)\nCONCLUSION: (1 sentence)\nACTION: (optional next step)`;

  let rawResponse: string;
  try {
    const result = await brain.call({
      source: 'consciousness',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: REFLECT_MAX_TOKENS,
      temperature: REFLECT_TEMPERATURE,
    });
    rawResponse = result.content;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `reflect: brain.call failed — ${msg}`,
      'consciousness_meta_brain_failed',
      { episodeId, cause: msg },
    );
  }

  if (!rawResponse || typeof rawResponse !== 'string' || rawResponse.trim().length === 0) {
    throw new ConsciousnessError(
      'reflect: brain returned empty response',
      'consciousness_meta_brain_failed',
      { episodeId },
    );
  }

  const parsed = parseReflectionResponse(rawResponse);

  const reflection: Reflection = {
    id: genId(),
    subjectEpisodeId: episodeId,
    question,
    analysis: parsed.analysis,
    conclusion: parsed.conclusion,
    actionItem: parsed.actionItem,
    qualityScore: parsed.qualityScore,
    createdAt: new Date().toISOString(),
  };

  saveReflection(db, reflection);

  log.info(
    {
      id: reflection.id,
      episodeId,
      qualityScore: reflection.qualityScore,
      hasActionItem: reflection.actionItem !== null,
    },
    'Reflection generated and saved',
  );

  return reflection;
}

// ---------------------------------------------------------------------------
// runBatchReflection
// ---------------------------------------------------------------------------

/**
 * Reflect on a batch of recent significant episodes not yet reflected on.
 *
 * Checks existing reflections for each episode and skips those already
 * processed to avoid duplication.
 *
 * @param brain          - LLM brain interface.
 * @param db             - Active better-sqlite3 Database instance.
 * @param episodicMemory - Episodic memory interface.
 * @param count          - Number of significant episodes to consider.
 * @returns Array of newly created Reflection records.
 * @throws ConsciousnessError on invalid input.
 */
export async function runBatchReflection(
  brain: MetaBrainLike,
  db: Database.Database,
  episodicMemory: MetaEpisodicLike,
  count: number,
): Promise<Reflection[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'runBatchReflection: count must be a positive integer',
      'consciousness_meta_invalid_input',
      { count },
    );
  }

  log.info({ count }, 'runBatchReflection starting');

  const episodes = episodicMemory.getBySignificance(count).filter(
    (ep) => ep.significance >= MIN_SIGNIFICANCE_FOR_BATCH,
  );

  log.debug({ total: episodes.length }, 'Candidate episodes retrieved for reflection');

  const results: Reflection[] = [];

  for (const episode of episodes) {
    // Skip episodes that already have reflections
    let existing: Reflection[];
    try {
      existing = getByEpisode(db, episode.id);
    } catch {
      existing = [];
    }

    if (existing.length > 0) {
      log.debug({ episodeId: episode.id }, 'Episode already reflected on — skipping');
      continue;
    }

    try {
      const r = await reflect(brain, db, episode.id, episode.summary, episode.outcome);
      results.push(r);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ episodeId: episode.id, error: msg }, 'reflect() failed for episode — skipping');
    }
  }

  log.info({ processed: results.length, requested: count }, 'runBatchReflection complete');
  return results;
}
