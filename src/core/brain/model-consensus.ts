/**
 * Upgrade 55: Multi-Model Consensus
 *
 * Query all 4 models in parallel and derive the best answer via
 * Jaccard-similarity agreement scoring.  Also exposes a race mode
 * (first response wins) and a side-by-side comparison formatter.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:consensus');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelAnswer {
  model: string;
  content: string;
  latencyMs: number;
  confidence: number;
}

/** Extended answer for BrainResponse consensus — includes tool calls and usage. */
export interface BrainModelResult {
  model: string;
  content: string;
  toolCalls: unknown[];
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCost: number };
}

export interface ConsensusResult {
  answers: ModelAnswer[];
  bestAnswer: ModelAnswer;
  /** 0–1 — how much the models agree on content */
  agreement: number;
  method: 'fastest' | 'consensus' | 'best-model';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODELS = [
  'ollama/kimi-k2.6:cloud',
  'ollama/glm-5.1:cloud',
  'ollama/deepseek-v4-pro:cloud',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute average pairwise Jaccard similarity over words longer than 4 chars.
 */
function calculateAgreement(answers: ModelAnswer[]): number {
  if (answers.length < 2) return 1;

  const wordSets = answers.map(
    (a) =>
      new Set(
        a.content
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 4),
      ),
  );

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = new Set([...wordSets[i]].filter((w) => wordSets[j].has(w)));
      const union = new Set([...wordSets[i], ...wordSets[j]]);
      totalSim += union.size > 0 ? intersection.size / union.size : 0;
      pairs++;
    }
  }

  return pairs > 0 ? totalSim / pairs : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Query all models in parallel for BrainResponse results.
 *
 * Selection strategy:
 *  - agreement > 0.7  → pick the fastest responder (consensus mode)
 *  - agreement <= 0.7 → pick the most-detailed reply (best-model mode)
 *
 * @param models   Array of model IDs to query.
 * @param caller   Async function that calls one model and returns BrainModelResult.
 */
export async function queryAllModelsConsensus(
  models: string[],
  caller: (model: string) => Promise<BrainModelResult>,
): Promise<{ result: BrainModelResult; agreement: number; method: 'fastest' | 'most-detailed' }> {
  if (models.length === 0) throw new Error('models array must not be empty');

  const wallStart = Date.now();

  const settled = await Promise.allSettled(
    models.map(async (model): Promise<BrainModelResult> => {
      const t0 = Date.now();
      const result = await caller(model);
      return { ...result, latencyMs: Date.now() - t0 };
    }),
  );

  const results: BrainModelResult[] = settled
    .filter((r): r is PromiseFulfilledResult<BrainModelResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  const failed = settled.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn({ failed, succeeded: results.length }, 'Some models failed');
  }

  if (results.length === 0) {
    throw new Error('All models failed — no answers received');
  }

  // Calculate agreement based on content similarity
  const agreement = calculateAgreementFromResults(results);

  // Pick winner: fastest if agreement high, most-detailed if disagreement
  const bestResult =
    agreement > 0.7
      ? results.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b))
      : results.reduce((a, b) => {
          const aLen = a.content.length + (a.toolCalls?.length ?? 0) * 100;
          const bLen = b.content.length + (b.toolCalls?.length ?? 0) * 100;
          return aLen > bLen ? a : b;
        });

  const method: 'fastest' | 'most-detailed' = agreement > 0.7 ? 'fastest' : 'most-detailed';

  log.info(
    {
      models: results.length,
      agreement: agreement.toFixed(3),
      best: bestResult.model,
      method,
      totalMs: Date.now() - wallStart,
    },
    'Consensus reached',
  );

  return { result: bestResult, agreement, method };
}

function calculateAgreementFromResults(results: BrainModelResult[]): number {
  if (results.length < 2) return 1;

  const wordSets = results.map((r) =>
    new Set(
      r.content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4),
    ),
  );

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = new Set([...wordSets[i]].filter((w) => wordSets[j].has(w)));
      const union = new Set([...wordSets[i], ...wordSets[j]]);
      totalSim += union.size > 0 ? intersection.size / union.size : 0;
      pairs++;
    }
  }

  return pairs > 0 ? totalSim / pairs : 0;
}

/**
 * Query all models in parallel.
 *
 * Selection strategy:
 *  - agreement > 0.7  → pick the fastest responder  (consensus mode)
 *  - agreement <= 0.7 → pick the most-detailed reply (best-model mode)
 *
 * @param prompt   The user/system prompt to send to every model.
 * @param fetcher  Async function that calls one model and returns its text.
 */
export async function queryAllModels(
  prompt: string,
  fetcher: (model: string, prompt: string) => Promise<string>,
): Promise<ConsensusResult> {
  if (!prompt?.trim()) throw new Error('prompt must not be empty');

  const wallStart = Date.now();

  const settled = await Promise.allSettled(
    MODELS.map(async (model): Promise<ModelAnswer> => {
      const t0 = Date.now();
      const content = await fetcher(model, prompt);
      return { model, content, latencyMs: Date.now() - t0, confidence: 1.0 };
    }),
  );

  const answers: ModelAnswer[] = settled
    .filter((r): r is PromiseFulfilledResult<ModelAnswer> => r.status === 'fulfilled')
    .map((r) => r.value);

  const failed = settled.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn({ failed, succeeded: answers.length }, 'Some models failed');
  }

  if (answers.length === 0) {
    throw new Error('All models failed — no answers received');
  }

  const agreement = calculateAgreement(answers);

  const bestAnswer =
    agreement > 0.7
      ? answers.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b))
      : answers.reduce((a, b) => (a.content.length > b.content.length ? a : b));

  const method: ConsensusResult['method'] =
    agreement > 0.7 ? 'consensus' : 'best-model';

  log.info(
    {
      models: answers.length,
      agreement: agreement.toFixed(3),
      best: bestAnswer.model,
      method,
      totalMs: Date.now() - wallStart,
    },
    'Consensus reached',
  );

  return { answers, bestAnswer, agreement, method };
}

/**
 * Race mode — send prompt to all models, resolve with whichever answers first.
 * Remaining in-flight requests are abandoned (Promise.any semantics).
 *
 * @param prompt   The prompt to broadcast.
 * @param fetcher  Model call function.
 */
export async function raceModels(
  prompt: string,
  fetcher: (model: string, prompt: string) => Promise<string>,
): Promise<ModelAnswer> {
  if (!prompt?.trim()) throw new Error('prompt must not be empty');

  const result = await Promise.any(
    MODELS.map(async (model): Promise<ModelAnswer> => {
      const t0 = Date.now();
      const content = await fetcher(model, prompt);
      return { model, content, latencyMs: Date.now() - t0, confidence: 1.0 };
    }),
  );

  log.info({ winner: result.model, latencyMs: result.latencyMs }, 'Race winner');
  return result;
}

/**
 * Format a ConsensusResult for human-readable side-by-side display.
 * Each answer is capped at 500 chars to keep the output scannable.
 */
export function formatComparison(result: ConsensusResult): string {
  if (!result?.answers?.length) return 'No answers to compare.';

  const lines: string[] = [
    `**Model Comparison** (agreement: ${(result.agreement * 100).toFixed(0)}%)\n`,
  ];

  for (const a of result.answers) {
    const shortName = a.model.split('/')[1] ?? a.model;
    lines.push(`**${shortName}** (${a.latencyMs}ms):`);
    lines.push(a.content.substring(0, 500));
    lines.push('');
  }

  const bestName = result.bestAnswer.model.split('/')[1] ?? result.bestAnswer.model;
  lines.push(`**Best:** ${bestName} (${result.method})`);

  return lines.join('\n');
}
