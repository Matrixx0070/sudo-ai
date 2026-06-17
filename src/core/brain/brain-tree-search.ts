/**
 * @file brain-tree-search.ts
 * @description Verifier-guided tree-search orchestrator + Reflexion
 * failure memory — Stage 3 of the kimi+glm Mythos-beating brain
 * architecture (PR #240). Sits ABOVE the debate orchestrator from #239.
 *
 * Protocol (loose adaptation of Devin's SWE-bench technique +
 * Shinn et al. 2023 Reflexion):
 *
 *   1. Initialise an empty failure log (Reflexion memory).
 *   2. Run N debate rounds (default 3). Each round receives the
 *      cumulative failure log as an extra system note so it sees the
 *      lessons from previous candidates.
 *   3. Score each candidate with the algorithmic verifier (see below).
 *      A failing verification appends a structured note to the log
 *      ("CANDIDATE k FAILED: …") that the next round consumes.
 *   4. Return the highest-scoring candidate. Ties broken by recency
 *      (later candidates incorporated more failure feedback).
 *
 * Algorithmic verifier — Stage 3 placeholder:
 *   The real test-execution / sympy / search-cross-check verifiers
 *   land in #241–#243 (Stage 2 of the broader plan). For now the
 *   verifier is a pluggable function with a sensible default that
 *   checks: non-empty content, no obvious model-refusal patterns,
 *   no contradiction with prior failure-log notes. This keeps the
 *   tree-search wiring real, testable, and ready to swap in the
 *   stronger judge without touching call sites.
 *
 * Cost model: M candidates × 3-round debate. With the default M=3 and
 * the cloud kimi+glm models on the user's Ollama Max plan, this is a
 * fixed-cost upgrade over single-call — no per-token explosion.
 *
 * Wire-in: the Brain class's `call()` consults the resolved effective
 * strategy. `single` → existing failover path (unchanged). `debate` →
 * runDebate from #239. `tree-search` → this module. The router lives
 * in brain.ts and ships in the same PR (#240) as this orchestrator.
 */

import { createLogger } from '../shared/logger.js';
import { runDebate, type DebateOpts } from './brain-debate.js';
import type { Brain } from './brain.js';
import type { BrainMessage, BrainRequest, BrainResponse, TokenUsage } from './types.js';

const log = createLogger('brain-tree-search');

/** Default fan-out for tree-search candidates. Tunable via opts. */
export const DEFAULT_TREE_BREADTH = 3;

/** Options passed to the tree-search orchestrator. */
export interface TreeSearchOpts extends DebateOpts {
  /** Number of debate candidates to generate. Default 3. */
  breadth?: number;
  /**
   * Custom verifier. Returns a score in [0, 1] and an optional reason
   * appended to the Reflexion failure log when score < 0.5. The default
   * verifier (`defaultVerifier`) does light sanity checks; #241+ swap
   * in test-execution / symbolic / search cross-check.
   */
  verifier?: (candidate: BrainResponse, request: BrainRequest) => Promise<VerifierResult> | VerifierResult;
}

/** One round of verifier output. */
export interface VerifierResult {
  /** 0 = certainly wrong, 1 = certainly right. */
  score: number;
  /** Short note appended to the Reflexion log when score < 0.5. */
  reason?: string;
}

/**
 * Sum two token-usage rows. Duplicated from brain-debate.ts rather than
 * exported to keep the orchestrators decoupled.
 */
function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimatedCost: a.estimatedCost + b.estimatedCost,
  };
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 };

/**
 * Default verifier — light sanity checks. Returns 1.0 for plausible
 * answers, 0.3 for empty/refusal/short. Real algorithmic judges land
 * in #241+.
 */
export function defaultVerifier(candidate: BrainResponse): VerifierResult {
  const content = (candidate.content ?? '').trim();
  if (content.length === 0) return { score: 0.0, reason: 'empty content' };
  if (content.length < 20) return { score: 0.3, reason: 'suspiciously short answer' };
  // Common refusal / disclaimer patterns that usually indicate the model
  // bailed rather than answering.
  if (/^(i\s+(?:can\s*not|cannot|can'?t)|i\s+(?:am|'m)\s+unable|sorry,?\s+i\s+(?:can\s*not|cannot))/i.test(content)) {
    return { score: 0.2, reason: 'refusal-style answer' };
  }
  return { score: 1.0 };
}

/**
 * Inject the Reflexion failure log as an extra system-style note in
 * front of the user message. We use a `user`-role prepend rather than
 * editing the system prompt so the brain's full system-prompt assembly
 * pipeline (persona, mood, tools, RAG, lenses) keeps owning the actual
 * system message.
 */
function injectFailureLog(request: BrainRequest, log: string[]): BrainRequest {
  if (log.length === 0) return request;
  const note = [
    'PRIOR ATTEMPT FAILURES (Reflexion memory) — do not repeat these mistakes:',
    ...log.map((entry, i) => `  ${i + 1}. ${entry}`),
    '',
    'Now answer the request below incorporating these lessons.',
  ].join('\n');
  const reflexionMsg: BrainMessage = { role: 'user', content: note };
  return { ...request, messages: [reflexionMsg, ...request.messages] };
}

/**
 * Run a verifier-guided tree search over N debate candidates with a
 * shared Reflexion failure log. Returns the highest-scoring candidate;
 * ties broken by recency.
 */
export async function runTreeSearch(
  brain: Brain,
  request: BrainRequest,
  opts: TreeSearchOpts = {},
): Promise<BrainResponse> {
  const breadth = Math.max(1, opts.breadth ?? DEFAULT_TREE_BREADTH);
  const verifier = opts.verifier ?? defaultVerifier;
  const failureLog: string[] = [];
  const candidates: Array<{ resp: BrainResponse; score: number; idx: number }> = [];
  let totalUsage: TokenUsage = ZERO_USAGE;
  const t0 = Date.now();

  log.info({ breadth }, 'Tree-search: starting candidate generation');

  for (let i = 0; i < breadth; i++) {
    const candidateReq = injectFailureLog(request, failureLog);
    // Pull out the debate-specific opts. TS infers correctly via spread
    // but the explicit pluck keeps the call narrow.
    const debateOpts: DebateOpts = {};
    if (opts.blueModel !== undefined) debateOpts.blueModel = opts.blueModel;
    if (opts.redModel !== undefined) debateOpts.redModel = opts.redModel;
    if (opts.skipCritique !== undefined) debateOpts.skipCritique = opts.skipCritique;

    let resp: BrainResponse;
    try {
      resp = await runDebate(brain, candidateReq, debateOpts);
    } catch (err) {
      // A round failure (provider blip, timeout) is itself a Reflexion
      // signal — log it and keep going. If every round fails we throw
      // at the end so the caller sees the underlying error.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ candidateIdx: i, err: msg }, 'Tree-search: candidate threw — recording in failure log');
      failureLog.push(`Candidate ${i + 1}: round error — ${msg}`);
      continue;
    }
    totalUsage = addUsage(totalUsage, resp.usage);

    const verdict = await verifier(resp, request);
    if (verdict.score < 0.5 && verdict.reason) {
      failureLog.push(`Candidate ${i + 1} (score ${verdict.score.toFixed(2)}): ${verdict.reason}`);
    }
    candidates.push({ resp, score: verdict.score, idx: i });

    log.info(
      { candidateIdx: i, score: verdict.score, contentLen: (resp.content ?? '').length },
      'Tree-search: candidate scored',
    );

    // Short-circuit if the first plausible candidate aces verification
    // and we've explored at least one alternative — saves the remaining
    // rounds when the answer is clearly right. Always run at least one
    // alternative so we have something to compare against.
    if (verdict.score >= 0.99 && i >= 1) {
      log.info({ candidateIdx: i, score: verdict.score }, 'Tree-search: high-confidence candidate — early exit');
      break;
    }
  }

  if (candidates.length === 0) {
    throw new Error(`tree-search: every candidate failed across ${breadth} rounds`);
  }

  // Highest score wins; ties broken by recency (higher idx wins) since
  // later candidates incorporated more failure-log feedback.
  candidates.sort((a, b) => (b.score - a.score) || (b.idx - a.idx));
  const winner = candidates[0]!;

  log.info(
    { ms: Date.now() - t0, winnerIdx: winner.idx, winnerScore: winner.score, totalCandidates: candidates.length, failureLogSize: failureLog.length },
    'Tree-search: complete',
  );

  return { ...winner.resp, usage: totalUsage };
}
