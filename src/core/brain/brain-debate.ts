/**
 * @file brain-debate.ts
 * @description Blue/Red/Revise debate orchestrator — Stage 2 of the
 * kimi+glm Mythos-beating brain architecture (PR #239, follow-up to
 * #238's plumbing).
 *
 * Protocol (Du et al. 2023, adapted):
 *
 *   1. Blue (proposer)   — runs the user request and produces a draft answer
 *                          using the FULL tool set, so it can grep, read,
 *                          execute, browse, etc. Mirrors single-call.
 *   2. Red  (critic)     — receives Blue's answer and the original request;
 *                          tries to falsify it. Lists concrete failure
 *                          modes, edge cases, factual errors, dead links,
 *                          missing tool calls.
 *   3. Revise (proposer) — Blue, re-engaged with Red's critique, produces a
 *                          final answer that either rebuts each point or
 *                          incorporates the fix. Tools available again.
 *
 * Default models — kimi-k2.7-code as Blue (constructive code/agent
 * reasoning), glm-5.2 as Red (sharp critique style). Both ollama-cloud,
 * both covered by the user's max plan. Overridable via opts so this
 * works on the existing failover chain when the cloud models are not
 * configured.
 *
 * Zero new I/O at module top level: every call site goes through
 * `brain.call({ ... })` with its strategy override pinned to `single`.
 * That forces the underlying brain to execute one direct sequential
 * failover round per role, so tools, telemetry, RAG, lenses, negative
 * routing — every existing mechanism — still runs. Debate is an
 * orchestration layer above brain.call, not a replacement of it.
 *
 * What this PR is NOT yet:
 *   - Routing from brain.call() into this orchestrator. That switch
 *     lands in #240 alongside the tree-search wrapper so the two
 *     advanced strategies share the same wire-in.
 *   - An algorithmic judge. The Revise pass IS the judge today; the
 *     stronger verifier (test-execution / sympy / search cross-check)
 *     is Stage 2 (PR #241+).
 */

import { createLogger } from '../shared/logger.js';
import type { Brain } from './brain.js';
import type { BrainMessage, BrainRequest, BrainResponse, TokenUsage } from './types.js';

const log = createLogger('brain-debate');

/** Default Ollama-cloud models for the two debate roles. Override via opts. */
export const DEFAULT_BLUE_MODEL = 'ollama/kimi-k2.7-code:cloud';
export const DEFAULT_RED_MODEL = 'ollama/glm-5.2:cloud';

/** Options passed to the debate orchestrator. */
export interface DebateOpts {
  /** Override the Blue (proposer) model. */
  blueModel?: string;
  /** Override the Red (critic) model. */
  redModel?: string;
  /**
   * Skip the Red critique pass and return Blue's first answer. Used by
   * the tier-fallback path when the configured strategy is `debate` but
   * the caller flagged `tier: 'fast'`. Should never happen via the
   * normal resolution path (`fast` short-circuits to `single` before
   * we get here), but harden defensively.
   */
  skipCritique?: boolean;
}

/**
 * Sum two token-usage rows. Used to roll the Blue + Red + Revise totals
 * into a single BrainResponse.usage so the caller's accounting and the
 * cost telemetry observe the full debate cost, not just the final round.
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

/**
 * Build the system-style critique prompt for Red. Kept as a prepended
 * user message rather than a system override so the brain's own
 * system-prompt assembly (persona, mood, tool catalog, RAG, lenses) is
 * preserved verbatim across rounds.
 */
function buildCritiquePrompt(originalUserText: string, blueAnswer: string): string {
  return [
    'You are the RED critic in a Blue/Red debate. Your job is to find errors,',
    'omissions, and edge cases in the BLUE proposer\'s answer below. Be specific:',
    'cite the failing case, the wrong assumption, the missing tool call. Do not',
    'rewrite the answer — just list concrete falsifications, one per line,',
    'numbered. If the answer is genuinely sound, write exactly: NO_FAULTS.',
    '',
    '--- ORIGINAL REQUEST ---',
    originalUserText,
    '',
    '--- BLUE PROPOSER ANSWER ---',
    blueAnswer,
    '',
    '--- YOUR CRITIQUE ---',
  ].join('\n');
}

/**
 * Build the Revise prompt for Blue. Includes the original request, the
 * first answer, and Red's critique. Blue's job here is to produce a
 * final answer — addressing each critique point — using tools again if
 * needed.
 */
function buildRevisePrompt(
  originalUserText: string,
  blueAnswer: string,
  redCritique: string,
): string {
  return [
    'You are BLUE on the REVISE round. Your previous answer is shown below,',
    'along with the RED critic\'s falsification list. Produce the FINAL answer:',
    '• If a critique point is correct, fix it (use tools if the fix needs',
    '  ground truth — re-read a file, re-grep, re-run a test).',
    '• If a critique point is wrong, rebut it briefly inline.',
    '• Do NOT mention the debate, BLUE/RED roles, or the round structure',
    '  in the final answer — the user only sees the final text.',
    '',
    '--- ORIGINAL REQUEST ---',
    originalUserText,
    '',
    '--- YOUR FIRST ANSWER ---',
    blueAnswer,
    '',
    '--- RED CRITIQUE ---',
    redCritique,
    '',
    '--- YOUR FINAL ANSWER ---',
  ].join('\n');
}

/**
 * Last user message text — used to anchor the critique and revise prompts
 * on the actual question the user asked, not the synthesised debate
 * transcript.
 */
function lastUserText(messages: BrainMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return m.content ?? '';
  }
  return '';
}

/**
 * Run a Blue/Red/Revise debate and return a single BrainResponse. The
 * returned `content` is Blue's REVISE answer (third round). The `usage`
 * is summed across all rounds so the caller's token accounting sees the
 * full cost. The `model` is reported as the Revise model (Blue), since
 * that's whose output is being returned.
 *
 * Each round goes through brain.call({ ..., model: X }, { strategy:
 * 'single' }) — the strategy override prevents recursion if a future
 * caller sets the ambient strategy to `debate`.
 */
export async function runDebate(
  brain: Brain,
  request: BrainRequest,
  opts: DebateOpts = {},
): Promise<BrainResponse> {
  const blueModel = opts.blueModel ?? DEFAULT_BLUE_MODEL;
  const redModel = opts.redModel ?? DEFAULT_RED_MODEL;
  const userText = lastUserText(request.messages);
  const t0 = Date.now();

  log.info(
    { blueModel, redModel, skipCritique: opts.skipCritique ?? false },
    'Debate: starting Blue/Red/Revise',
  );

  // --- Round 1: Blue (proposer with full tools) -----------------------------
  const blueResp = await brain.call(
    { ...request, model: blueModel },
    { strategy: 'single' },
  );
  let totalUsage: TokenUsage = blueResp.usage;
  const blueAnswer = blueResp.content ?? '';

  // Defensive short-circuit: tier=fast resolved to single upstream, but if
  // a caller bypassed that resolution and called runDebate directly with
  // skipCritique, honour it and stop at round 1.
  if (opts.skipCritique || blueAnswer.trim() === '') {
    log.info({ ms: Date.now() - t0, reason: opts.skipCritique ? 'skipCritique' : 'empty-blue' },
      'Debate: short-circuited after Round 1');
    return { ...blueResp, usage: totalUsage };
  }

  // --- Round 2: Red (critic, NO tools — pure critique) ----------------------
  // Stripping tools from the critique call keeps Red focused on the answer
  // text and avoids accidental side-effecting tool runs from the critic
  // role. Blue already explored ground truth; Red's job is verbal.
  const critiqueRequest: BrainRequest = {
    ...request,
    model: redModel,
    tools: [],
    messages: [
      ...request.messages,
      { role: 'user', content: buildCritiquePrompt(userText, blueAnswer) },
    ],
  };
  const redResp = await brain.call(critiqueRequest, { strategy: 'single' });
  totalUsage = addUsage(totalUsage, redResp.usage);
  const redCritique = (redResp.content ?? '').trim();

  // If Red found nothing actionable, return Blue's answer with summed
  // usage. No point spending a third round to re-confirm.
  if (redCritique === '' || /^NO_FAULTS\b/i.test(redCritique)) {
    log.info({ ms: Date.now() - t0, reason: 'no-faults' }, 'Debate: Red found no faults, returning Blue');
    return { ...blueResp, usage: totalUsage };
  }

  // --- Round 3: Revise (Blue re-engaged with tools + critique) --------------
  const reviseRequest: BrainRequest = {
    ...request,
    model: blueModel,
    messages: [
      ...request.messages,
      { role: 'assistant', content: blueAnswer },
      { role: 'user', content: buildRevisePrompt(userText, blueAnswer, redCritique) },
    ],
  };
  const reviseResp = await brain.call(reviseRequest, { strategy: 'single' });
  totalUsage = addUsage(totalUsage, reviseResp.usage);

  // Reasoning models (kimi-k2.7-code, glm-5.2) emit content ONLY after
  // their `reasoning` field completes. On a hard prompt, Revise can burn
  // its entire maxTokens budget on reasoning and finish with empty
  // content. Observed live on a Damerau-Levenshtein run (2026-06-17):
  // Revise returned empty content despite Blue+Red rounds being healthy.
  // Fall back to Blue's answer in that case — telemetry still records
  // the Revise round happened (summed usage) so the cost/quality story
  // stays honest, but the caller sees a valid answer instead of an empty
  // string. Tree-search's Reflexion loop already routes around this at a
  // higher layer, but the bare-debate path (no tree-search) needs its own
  // floor.
  const reviseAnswer = (reviseResp.content ?? '').trim();
  if (reviseAnswer === '') {
    log.warn(
      { ms: Date.now() - t0, critiqueLen: redCritique.length, blueLen: blueAnswer.length },
      'Debate: Revise returned empty content — falling back to Blue',
    );
    return { ...blueResp, usage: totalUsage };
  }

  log.info(
    { ms: Date.now() - t0, critiqueLen: redCritique.length, finalLen: (reviseResp.content ?? '').length },
    'Debate: complete',
  );

  return { ...reviseResp, usage: totalUsage };
}
