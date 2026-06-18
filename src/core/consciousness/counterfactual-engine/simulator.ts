/**
 * @file simulator.ts
 * @description LLM-driven counterfactual simulation for the consciousness layer.
 * simulate() — one counterfactual. runIdleBatch() — batch over significant episodes.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import type { CFBrainLike, CFEpisodicLike, Counterfactual } from './types.js';
import { saveCounterfactual, getByEpisode } from './store.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('counterfactual-engine:simulator');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIMULATE_MAX_TOKENS = 400;
const SIMULATE_TEMPERATURE = 0.7;
const ALT_ACTION_MAX_TOKENS = 150;
const ALT_ACTION_TEMPERATURE = 0.8;
const DEFAULT_CONFIDENCE = 0.6;
const MIN_SIGNIFICANCE_FOR_BATCH = 0.4;

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the value following "LABEL:" from LLM text (case-insensitive).
 * Returns empty string if the label is not found.
 */
function extractSection(text: string, label: string): string {
  const pattern = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\n[A-Z]+\\s*:|$)`, 'is');
  const match = pattern.exec(text);
  return match?.[1]?.trim() ?? '';
}

/**
 * Parse the simulation response (prose + DELTA:/LESSON: sections) with fallbacks.
 */
function parseSimulationResponse(raw: string): {
  simulatedOutcome: string;
  deltaAssessment: string;
  lessonLearned: string | null;
  confidence: number;
} {
  const trimmed = raw.trim();

  // Extract DELTA and LESSON sections
  const delta = extractSection(trimmed, 'DELTA');
  const lesson = extractSection(trimmed, 'LESSON');

  // Simulated outcome = everything before the first labelled section
  const firstLabelIdx = trimmed.search(/\n[A-Z]+\s*:/);
  const simulatedOutcome =
    firstLabelIdx > 0 ? trimmed.slice(0, firstLabelIdx).trim() : trimmed;

  // Normalise delta to one of the three valid values
  const lowerDelta = delta.toLowerCase();
  let deltaAssessment = 'same';
  if (lowerDelta.includes('better')) deltaAssessment = 'better';
  else if (lowerDelta.includes('worse')) deltaAssessment = 'worse';

  // Confidence heuristic: longer simulated outcome = slightly more confident
  const wordCount = simulatedOutcome.split(/\s+/).length;
  const confidence = Math.min(0.9, DEFAULT_CONFIDENCE + wordCount * 0.005);

  return {
    simulatedOutcome: simulatedOutcome || 'Unable to determine simulated outcome.',
    deltaAssessment,
    lessonLearned: lesson.length > 0 ? lesson : null,
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

/**
 * Generate and persist a single counterfactual for an episode.
 *
 * @param brain             - LLM brain interface.
 * @param db                - Active better-sqlite3 Database instance.
 * @param episodeId         - ID of the source episode.
 * @param episodeSummary    - Summary text of the episode.
 * @param actualOutcome     - What actually happened in the episode.
 * @param alternativeAction - The alternative action to evaluate.
 * @returns The saved Counterfactual record.
 * @throws ConsciousnessError on validation or LLM failure.
 */
export async function simulate(
  brain: CFBrainLike,
  db: Database.Database,
  episodeId: string,
  episodeSummary: string,
  actualOutcome: string,
  alternativeAction: string,
): Promise<Counterfactual> {
  // Input validation
  if (!episodeId || typeof episodeId !== 'string') {
    throw new ConsciousnessError(
      'simulate: episodeId must be a non-empty string',
      'consciousness_cf_invalid_input',
      { episodeId },
    );
  }
  if (!episodeSummary || typeof episodeSummary !== 'string') {
    throw new ConsciousnessError(
      'simulate: episodeSummary must be a non-empty string',
      'consciousness_cf_invalid_input',
      { episodeId },
    );
  }
  if (!actualOutcome || typeof actualOutcome !== 'string') {
    throw new ConsciousnessError(
      'simulate: actualOutcome must be a non-empty string',
      'consciousness_cf_invalid_input',
      { episodeId },
    );
  }
  if (!alternativeAction || typeof alternativeAction !== 'string') {
    throw new ConsciousnessError(
      'simulate: alternativeAction must be a non-empty string',
      'consciousness_cf_invalid_input',
      { episodeId },
    );
  }

  log.info({ episodeId, alternativeAction: alternativeAction.slice(0, 60) }, 'Starting simulation');

  const prompt =
    `Given this situation: ${episodeSummary}. ` +
    `The actual action led to: ${actualOutcome}. ` +
    `What if instead: ${alternativeAction}? ` +
    `Predict the likely outcome in 2-3 sentences. ` +
    `Then assess:\nDELTA: was this better/worse/same?\nLESSON: what can be learned?`;

  let rawResponse: string;
  try {
    const result = await brain.call({
      source: 'consciousness',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: SIMULATE_MAX_TOKENS,
      temperature: SIMULATE_TEMPERATURE,
    });
    rawResponse = result.content;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `simulate: brain.call failed — ${msg}`,
      'consciousness_cf_brain_failed',
      { episodeId, cause: msg },
    );
  }

  if (!rawResponse || typeof rawResponse !== 'string' || rawResponse.trim().length === 0) {
    throw new ConsciousnessError(
      'simulate: brain returned empty response',
      'consciousness_cf_brain_failed',
      { episodeId },
    );
  }

  const parsed = parseSimulationResponse(rawResponse);

  const cf: Counterfactual = {
    id: genId(),
    originalEpisodeId: episodeId,
    alternativeAction,
    simulatedOutcome: parsed.simulatedOutcome,
    actualOutcome,
    deltaAssessment: parsed.deltaAssessment,
    lessonLearned: parsed.lessonLearned,
    confidence: parsed.confidence,
    createdAt: new Date().toISOString(),
  };

  saveCounterfactual(db, cf);

  log.info(
    { id: cf.id, episodeId, delta: cf.deltaAssessment, confidence: cf.confidence },
    'Counterfactual simulated and saved',
  );

  return cf;
}

// ---------------------------------------------------------------------------
// runIdleBatch
// ---------------------------------------------------------------------------

/**
 * Generate counterfactuals for a batch of recent significant episodes.
 *
 * For each episode not already processed, a micro LLM call first proposes
 * an alternative action, then simulate() is invoked. Episodes that already
 * have existing counterfactuals are skipped to avoid duplication.
 *
 * @param brain          - LLM brain interface.
 * @param db             - Active better-sqlite3 Database instance.
 * @param episodicMemory - Episodic memory interface.
 * @param count          - Number of recent significant episodes to process.
 * @returns Array of newly created Counterfactual records.
 * @throws ConsciousnessError on invalid input.
 */
export async function runIdleBatch(
  brain: CFBrainLike,
  db: Database.Database,
  episodicMemory: CFEpisodicLike,
  count: number,
): Promise<Counterfactual[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'runIdleBatch: count must be a positive integer',
      'consciousness_cf_invalid_input',
      { count },
    );
  }

  log.info({ count }, 'runIdleBatch starting');

  const episodes = episodicMemory.getBySignificance(count).filter(
    (ep) => ep.significance >= MIN_SIGNIFICANCE_FOR_BATCH,
  );

  log.debug({ total: episodes.length }, 'Candidate episodes retrieved');

  const results: Counterfactual[] = [];

  for (const episode of episodes) {
    // Skip episodes that already have counterfactuals
    let existing: Counterfactual[];
    try {
      existing = getByEpisode(db, episode.id);
    } catch {
      existing = [];
    }

    if (existing.length > 0) {
      log.debug({ episodeId: episode.id }, 'Episode already has counterfactuals — skipping');
      continue;
    }

    // Step 1: Ask brain to propose an alternative action
    const altPrompt =
      `Given this episode: "${episode.summary}" with outcome: "${episode.outcome}", ` +
      `what is one specific alternative action that could have been taken? ` +
      `Reply with just the alternative action in 1-2 sentences.`;

    let alternativeAction: string;
    try {
      const altResult = await brain.call({
        source: 'consciousness',
        messages: [{ role: 'user', content: altPrompt }],
        maxTokens: ALT_ACTION_MAX_TOKENS,
        temperature: ALT_ACTION_TEMPERATURE,
      });
      alternativeAction = altResult.content.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ episodeId: episode.id, error: msg }, 'Failed to generate alternative action — skipping');
      continue;
    }

    if (!alternativeAction) {
      log.warn({ episodeId: episode.id }, 'Empty alternative action returned — skipping');
      continue;
    }

    // Step 2: Run full simulation
    try {
      const cf = await simulate(
        brain,
        db,
        episode.id,
        episode.summary,
        episode.outcome,
        alternativeAction,
      );
      results.push(cf);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ episodeId: episode.id, error: msg }, 'simulate() failed for episode — skipping');
    }
  }

  log.info({ processed: results.length, requested: count }, 'runIdleBatch complete');
  return results;
}
