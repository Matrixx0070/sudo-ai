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

/**
 * Options for latency-aware consensus preemption (early-exit). When neither
 * `minAgreement` nor `timeoutMs` is set, queryAllModelsConsensus waits for ALL
 * models (behavior-preserving default). Kill-switch: SUDO_CONSENSUS_EARLY_EXIT_DISABLE=1.
 */
export interface ConsensusOptions {
  /** If set (0–1), early-exit once `minResponders` models agree at ≥ this Jaccard score. */
  minAgreement?: number;
  /** Minimum completed responders before early-exit can fire. Default 2 (capped to model count). */
  minResponders?: number;
  /** Overall wall-clock cap (ms); resolves with whatever completed when it fires. */
  timeoutMs?: number;
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
  options: ConsensusOptions = {},
): Promise<{ result: BrainModelResult; agreement: number; method: 'fastest' | 'most-detailed' }> {
  if (models.length === 0) throw new Error('models array must not be empty');

  const wallStart = Date.now();
  // Normalize: only a POSITIVE agreement threshold or a POSITIVE timeout enables
  // early-exit. 0 / negative / NaN are treated as "unset" → wait-all default,
  // so a degenerate config can never prematurely collapse consensus.
  const minAgreement =
    typeof options.minAgreement === 'number' && options.minAgreement > 0 ? options.minAgreement : undefined;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  const earlyExitEnabled =
    process.env['SUDO_CONSENSUS_EARLY_EXIT_DISABLE'] !== '1' &&
    (minAgreement !== undefined || timeoutMs !== undefined);

  // -------------------------------------------------------------------------
  // Default path: wait for ALL models, then pick the winner. Behavior-preserving
  // — used whenever early-exit is not configured.
  // -------------------------------------------------------------------------
  if (!earlyExitEnabled) {
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

    const winner = selectConsensusWinner(results);
    log.info(
      { models: results.length, agreement: winner.agreement.toFixed(3), best: winner.result.model, method: winner.method, totalMs: Date.now() - wallStart },
      'Consensus reached',
    );
    return winner;
  }

  // -------------------------------------------------------------------------
  // Early-exit path: resolve as soon as a quorum of models AGREE (or on timeout),
  // without waiting for slower models. Pending calls are left to settle and their
  // late results ignored — no hard cancellation (that would require threading an
  // AbortSignal into the SDK). Slower models only cost wall-clock we no longer wait
  // on, never correctness.
  // -------------------------------------------------------------------------
  const minResponders = Math.min(Math.max(1, options.minResponders ?? 2), models.length);

  return await new Promise((resolve, reject) => {
    const results: BrainModelResult[] = [];
    let settledCount = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const conclude = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (results.length === 0) {
        reject(new Error('All models failed — no answers received'));
        return;
      }
      const winner = selectConsensusWinner(results);
      log.info(
        { models: results.length, agreement: winner.agreement.toFixed(3), best: winner.result.model, method: winner.method, earlyExit: settledCount < models.length, totalMs: Date.now() - wallStart },
        'Consensus reached (early-exit)',
      );
      resolve(winner);
    };

    for (const model of models) {
      const t0 = Date.now();
      caller(model)
        .then((r) => {
          if (!done) results.push({ ...r, latencyMs: Date.now() - t0 });
        })
        .catch(() => {
          /* swallow — a failed model simply does not contribute a result */
        })
        .finally(() => {
          settledCount += 1;
          if (done) return;
          try {
            if (
              typeof minAgreement === 'number' &&
              results.length >= minResponders &&
              calculateAgreementFromResults(results) >= minAgreement
            ) {
              conclude();
              return;
            }
          } catch (err) {
            // Defensive: never let an agreement-calc throw escape as an unhandled
            // rejection on this per-model chain — just skip this tick.
            log.warn({ err: String(err) }, 'Consensus agreement check failed — ignoring this completion');
          }
          if (settledCount === models.length) conclude();
        });
    }

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(conclude, timeoutMs);
    }
  });
}

/**
 * Pick the consensus winner from a set of completed results:
 *  - agreement > 0.7  → fastest responder
 *  - agreement <= 0.7 → most-detailed reply (content length + tool calls)
 *
 * Shared by the wait-all and early-exit paths so selection is identical for any
 * given result set.
 */
function selectConsensusWinner(
  results: BrainModelResult[],
): { result: BrainModelResult; agreement: number; method: 'fastest' | 'most-detailed' } {
  const agreement = calculateAgreementFromResults(results);
  const result =
    agreement > 0.7
      ? results.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b))
      : results.reduce((a, b) => {
          const aLen = a.content.length + (a.toolCalls?.length ?? 0) * 100;
          const bLen = b.content.length + (b.toolCalls?.length ?? 0) * 100;
          return aLen > bLen ? a : b;
        });
  const method: 'fastest' | 'most-detailed' = agreement > 0.7 ? 'fastest' : 'most-detailed';
  return { result, agreement, method };
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
