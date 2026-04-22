/**
 * @file phases.ts
 * @description The five sleep-cycle phases, extracted for modularity.
 *
 * Each exported function executes one phase of the consolidation cycle.
 * All functions are pure side-effect executors: they mutate the counters
 * object passed in and may append to the summaries / insights arrays.
 * They do NOT touch the database — that is the consolidator's responsibility.
 */

import { createLogger } from '../../shared/logger.js';
import { generateDream } from './dream-generator.js';
import type {
  SleepBrainLike,
  SleepEpisodicLike,
  SleepCounterfactualLike,
  SleepTemporalSelfLike,
  SleepMetacognitionLike,
  SleepWisdomLike,
} from './types.js';

const log = createLogger('sleep-cycle:phases');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EPISODE_AGE_WEAKEN_DAYS = 7;

// ---------------------------------------------------------------------------
// Shared mutable accumulator passed between phases
// ---------------------------------------------------------------------------

export interface PhaseAccumulator {
  episodesReplayed: number;
  patternsFound: number;
  memoriesStrengthened: number;
  memoriesWeakened: number;
  insightsGenerated: number;
  counterfactualsRun: number;
  dreamJournalEntry: string;
  /** Episode summaries collected for later phases. */
  summaries: string[];
  /** Insight texts collected for the dream generator. */
  insightTexts: string[];
}

// ---------------------------------------------------------------------------
// Phase 1 — Experience Replay
// ---------------------------------------------------------------------------

/**
 * Retrieve the top 20 significant episodes, strengthen or weaken each based
 * on significance and age, and collect summaries for later phases.
 */
export function runPhase1ExperienceReplay(
  episodicMemory: SleepEpisodicLike,
  acc: PhaseAccumulator,
): void {
  const episodes = episodicMemory.getBySignificance(20);
  acc.episodesReplayed = episodes.length;
  const nowMs = Date.now();

  for (const ep of episodes) {
    if (ep.significance > 0.7) {
      episodicMemory.strengthenEpisode(ep.id, 0.05);
      acc.memoriesStrengthened++;
    } else if (ep.significance < 0.3) {
      const ageDays = (nowMs - new Date(ep.startedAt).getTime()) / MS_PER_DAY;
      if (ageDays > EPISODE_AGE_WEAKEN_DAYS) {
        episodicMemory.weakenEpisode(ep.id, 0.05);
        acc.memoriesWeakened++;
      }
    }
    acc.summaries.push(ep.summary);
  }

  log.debug(
    { episodesReplayed: acc.episodesReplayed, memoriesStrengthened: acc.memoriesStrengthened, memoriesWeakened: acc.memoriesWeakened },
    'Phase 1 complete',
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — Pattern Finding
// ---------------------------------------------------------------------------

/**
 * Ask the brain to identify patterns across episode summaries.
 * Parses the response for numbered / bulleted lines and stores each as a
 * 'pattern' insight in the wisdom store.
 */
export async function runPhase2PatternFinding(
  brain: SleepBrainLike,
  wisdomStore: SleepWisdomLike,
  acc: PhaseAccumulator,
): Promise<void> {
  try {
    const summaryBlock = acc.summaries.slice(0, 10).map((s, i) => `${i + 1}. ${s}`).join('\n');
    const response = await brain.call({
      messages: [{
        role: 'user',
        content: [
          'Analyse these recent experiences and identify 3-5 key patterns or lessons.',
          'List each insight on its own numbered line or bullet point.',
          '',
          summaryBlock || '(no recent experiences)',
        ].join('\n'),
      }],
      maxTokens: 400,
      temperature: 0.7,
    });

    const rawInsights = parseInsights(response.content);
    acc.patternsFound = rawInsights.length;

    for (const insight of rawInsights) {
      wisdomStore.storeInsight({
        category: 'pattern',
        source: 'sleep_cycle_phase2',
        insight,
        confidence: 0.7,
      });
      acc.insightTexts.push(insight);
      acc.insightsGenerated++;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'Phase 2 pattern finding failed — continuing');
  }

  log.debug({ patternsFound: acc.patternsFound, insightsGenerated: acc.insightsGenerated }, 'Phase 2 complete');
}

// ---------------------------------------------------------------------------
// Phase 3 — Counterfactual Simulation
// ---------------------------------------------------------------------------

/**
 * Run idle batch counterfactual simulations and store any lessons learned
 * as insights in the wisdom store.
 */
export async function runPhase3Counterfactuals(
  counterfactualEngine: SleepCounterfactualLike,
  wisdomStore: SleepWisdomLike,
  acc: PhaseAccumulator,
): Promise<void> {
  try {
    const counterfactuals = await counterfactualEngine.runIdleBatch(3);
    acc.counterfactualsRun = counterfactuals.length;

    for (const cf of counterfactuals) {
      if (cf.lessonLearned && cf.lessonLearned.trim().length > 0) {
        wisdomStore.storeInsight({
          category: 'counterfactual_lesson',
          source: 'sleep_cycle_phase3',
          insight: cf.lessonLearned,
          confidence: 0.6,
        });
        acc.insightTexts.push(cf.lessonLearned);
        acc.insightsGenerated++;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'Phase 3 counterfactuals failed — continuing');
  }

  log.debug({ counterfactualsRun: acc.counterfactualsRun }, 'Phase 3 complete');
}

// ---------------------------------------------------------------------------
// Phase 4 — Self-Update
// ---------------------------------------------------------------------------

/**
 * Take a temporal self-snapshot and run a batch metacognitive reflection
 * over recent episodes.
 */
export async function runPhase4SelfUpdate(
  temporalSelf: SleepTemporalSelfLike,
  metacognition: SleepMetacognitionLike,
): Promise<void> {
  try {
    temporalSelf.takeSnapshot({ dominantEmotion: 'calm' }, []);
    await metacognition.runBatchReflection(3);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'Phase 4 self-update failed — continuing');
  }

  log.debug('Phase 4 complete');
}

// ---------------------------------------------------------------------------
// Phase 5 — Dream Generation
// ---------------------------------------------------------------------------

/**
 * Generate a creative dream journal entry synthesising the cycle's experiences
 * and insights. Falls back to an empty string on failure.
 */
export async function runPhase5DreamGeneration(
  brain: SleepBrainLike,
  acc: PhaseAccumulator,
): Promise<void> {
  try {
    acc.dreamJournalEntry = await generateDream(
      brain,
      acc.summaries.slice(0, 5),
      acc.insightTexts.slice(0, 5),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'Phase 5 dream generation failed — using empty entry');
    acc.dreamJournalEntry = '';
  }

  log.debug('Phase 5 complete');
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response body into individual insight strings.
 * Handles numbered lists (1. 2.) and bullet points (- * •).
 *
 * @param text - Raw LLM response text.
 * @returns Array of non-trivial insight strings (>10 chars each).
 */
export function parseInsights(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  const lines = text.split('\n');
  const insights: string[] = [];

  for (const line of lines) {
    const trimmed = line.replace(/^[\d]+[.)]\s*/, '').replace(/^[-*•]\s*/, '').trim();
    if (trimmed.length > 10) insights.push(trimmed);
  }

  return insights;
}
