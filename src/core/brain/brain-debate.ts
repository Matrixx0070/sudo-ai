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
// Type-only: erased at compile time, so no runtime cycle with brain-tree-search
// (which imports runDebate).
import type { VerifierResult } from './brain-tree-search.js';

const log = createLogger('brain-debate');

/** Default Ollama-cloud models for the two debate roles. Override via opts
 * or env (SUDO_BRAIN_DEBATE_BLUE / SUDO_BRAIN_DEBATE_RED). */
export const DEFAULT_BLUE_MODEL = 'ollama/kimi-k2.7-code:cloud';
export const DEFAULT_RED_MODEL = 'ollama/glm-5.2:cloud';

function envModel(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Wall-clock budget for a whole debate (all rounds), ms. 0 = uncapped.
 * Checked BETWEEN rounds only — an in-flight provider call is never aborted,
 * so the cap bounds "do we start another round", not stream duration.
 */
export function debateMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SUDO_BRAIN_DEBATE_MAX_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

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
  /**
   * Score the debate winner. Mode via SUDO_BRAIN_DEBATE_VERIFIER:
   * unset/'log' = score is logged only (current-safe); 'fallback' = when the
   * Revise answer scores < 0.5 and Blue's original scores >= 0.5, return
   * Blue instead.
   */
  verifier?: (candidate: BrainResponse, request: BrainRequest) => Promise<VerifierResult> | VerifierResult;
}

/** Structured verdict Red is prompted to return. */
export interface RedVerdict {
  mark: '✓' | '✗' | '??';
  counterexample?: string;
  reachability?: string;
  diagnosis?: string;
}

/**
 * Parse Red's reply as a structured verdict. Accepts raw JSON or a
 * fenced ```json block; returns null on anything that doesn't parse to a
 * valid mark — callers then fall back to the legacy NO_FAULTS sentinel
 * path, byte-identical to the pre-verdict behavior. Exported for tests.
 */
export function parseRedVerdict(text: string): RedVerdict | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const mark = obj['mark'];
  if (mark !== '✓' && mark !== '✗' && mark !== '??') return null;
  const pick = (k: string): string | undefined =>
    typeof obj[k] === 'string' && (obj[k] as string).trim() !== '' ? (obj[k] as string) : undefined;
  const verdict: RedVerdict = { mark };
  const counterexample = pick('counterexample');
  const reachability = pick('reachability');
  const diagnosis = pick('diagnosis');
  if (counterexample !== undefined) verdict.counterexample = counterexample;
  if (reachability !== undefined) verdict.reachability = reachability;
  if (diagnosis !== undefined) verdict.diagnosis = diagnosis;
  return verdict;
}

/** Render a structured verdict back into critique text for the Revise round. */
function verdictToCritique(v: RedVerdict): string {
  const parts: string[] = [];
  if (v.diagnosis) parts.push(`Diagnosis: ${v.diagnosis}`);
  if (v.counterexample) parts.push(`Counterexample: ${v.counterexample}`);
  if (v.reachability) parts.push(`Reachability: ${v.reachability}`);
  if (v.mark === '??') parts.push('Verdict: UNCERTAIN — the critic could not confirm the answer is sound.');
  return parts.join('\n');
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
    'omissions, and edge cases in the BLUE proposer\'s answer below.',
    'Construct the WORST case first, then test its reachability: any',
    'counterexample must be REACHABLE from the stated inputs/environment —',
    'an unreachable counterexample is not a counterexample.',
    '',
    'Reply with ONLY a JSON object in this exact shape:',
    '{"mark": "✓" | "✗" | "??", "counterexample": "...", "reachability": "...", "diagnosis": "..."}',
    '  mark "✓"  = the answer is genuinely sound (omit the other fields)',
    '  mark "✗"  = you found a concrete, reachable fault (fill diagnosis +',
    '              counterexample + how it is reached)',
    '  mark "??" = you cannot confirm soundness (fill diagnosis with what is unverifiable)',
    '',
    '--- ORIGINAL REQUEST ---',
    originalUserText,
    '',
    '--- BLUE PROPOSER ANSWER ---',
    blueAnswer,
    '',
    '--- YOUR VERDICT (JSON only) ---',
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
 * Score the debate winner with the caller-supplied verifier (fail-open).
 * Mode SUDO_BRAIN_DEBATE_VERIFIER: unset/'log' = log the score only;
 * 'fallback' = on the revise path, if the revised answer scores < 0.5 and
 * Blue's original scores >= 0.5, return Blue (with the full summed usage).
 */
async function finishDebate(
  brain: Brain,
  request: BrainRequest,
  winner: BrainResponse,
  opts: DebateOpts,
  path: 'blue-no-faults' | 'revise' | 'blue-fallback',
  blueAlternative?: BrainResponse,
): Promise<BrainResponse> {
  if (!opts.verifier) return winner;
  try {
    const result = await opts.verifier(winner, request);
    log.info({ score: result.score, reason: result.reason, path }, 'Debate: verifier scored winner');
    const mode = process.env['SUDO_BRAIN_DEBATE_VERIFIER'];
    if (mode === 'fallback' && path === 'revise' && blueAlternative && result.score < 0.5) {
      const blueScore = await opts.verifier(blueAlternative, request);
      log.info({ blueScore: blueScore.score, reviseScore: result.score }, 'Debate: verifier fallback comparison');
      if (blueScore.score >= 0.5) {
        log.warn({ reviseScore: result.score, blueScore: blueScore.score },
          'Debate: revised answer scored below Blue — returning Blue (verifier fallback)');
        return { ...blueAlternative, usage: winner.usage };
      }
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Debate: verifier threw — ignoring score');
  }
  return winner;
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
  const blueModel = opts.blueModel ?? envModel('SUDO_BRAIN_DEBATE_BLUE') ?? DEFAULT_BLUE_MODEL;
  const redModel = opts.redModel ?? envModel('SUDO_BRAIN_DEBATE_RED') ?? DEFAULT_RED_MODEL;
  const maxMs = debateMaxMs();
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

  if (maxMs > 0 && Date.now() - t0 >= maxMs) {
    log.warn({ ms: Date.now() - t0, maxMs }, 'Debate: wall-clock cap hit after Round 1 — returning best-so-far');
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
  let redCritique = (redResp.content ?? '').trim();

  // Prefer the structured verdict; on any parse failure fall back to the
  // legacy sentinel semantics so a rambling critic degrades gracefully.
  const verdict = parseRedVerdict(redCritique);
  if (verdict) {
    log.info({ mark: verdict.mark, hasCounterexample: !!verdict.counterexample }, 'Debate: Red verdict parsed');
    if (verdict.mark === '✓') {
      log.info({ ms: Date.now() - t0, reason: 'no-faults' }, 'Debate: Red found no faults, returning Blue');
      return finishDebate(brain, request, { ...blueResp, usage: totalUsage }, opts, 'blue-no-faults');
    }
    redCritique = verdictToCritique(verdict) || redCritique;
  } else {
    log.debug({ len: redCritique.length }, 'Debate: Red reply not a structured verdict — sentinel fallback');
    // If Red found nothing actionable, return Blue's answer with summed
    // usage. No point spending a third round to re-confirm.
    if (redCritique === '' || /^NO_FAULTS\b/i.test(redCritique)) {
      log.info({ ms: Date.now() - t0, reason: 'no-faults' }, 'Debate: Red found no faults, returning Blue');
      return finishDebate(brain, request, { ...blueResp, usage: totalUsage }, opts, 'blue-no-faults');
    }
  }

  if (maxMs > 0 && Date.now() - t0 >= maxMs) {
    log.warn({ ms: Date.now() - t0, maxMs }, 'Debate: wall-clock cap hit after Round 2 — returning best-so-far');
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
    return finishDebate(brain, request, { ...blueResp, usage: totalUsage }, opts, 'blue-fallback');
  }

  log.info(
    { ms: Date.now() - t0, critiqueLen: redCritique.length, finalLen: (reviseResp.content ?? '').length },
    'Debate: complete',
  );

  return finishDebate(brain, request, { ...reviseResp, usage: totalUsage }, opts, 'revise', blueResp);
}
