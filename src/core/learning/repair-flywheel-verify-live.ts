/**
 * @file learning/repair-flywheel-verify-live.ts
 * @description Live A/B verification for GUIDANCE repairs (the exec-metachar cluster).
 *
 * The deterministic verifier (repair-flywheel-verify.ts) proves input-REWRITE
 * repairs offline. But the biggest real cluster — `system.exec` commands refused
 * by the repo-exec guard for shell metacharacters — is a GUIDANCE problem: the
 * agent chose a shell form the read-only sandbox forbids. You can't prove a
 * guidance lesson helps by pure input math; you need a model in the loop.
 *
 * This module makes that measurable and HONEST by splitting the two halves:
 *  - TRANSFORM (uncertain, live): an injected LLM rewrite re-expresses the refused
 *    command under the candidate lesson, or declares it IMPOSSIBLE.
 *  - VERIFY (exact, true-to-prod): the SAME `checkRepoCommand` guard the daemon
 *    runs decides whether the rewrite would actually be accepted.
 *
 * The recovery rate is therefore a real number: "of the commands the guard refused,
 * how many can the lesson turn into an accepted read-only command." A LOW rate is a
 * valid, useful finding — most repo-exec refusals are the agent trying to run a
 * non-allowlisted or multi-step command (pm2 restart, bash -lc, `a; b; c`), which is
 * CORRECTLY refused and not rewritable. In that case decideAdoption() rejects the
 * lesson — the verifier stops a useless lesson from ever shipping.
 *
 * EQUIVALENCE CAVEAT (measured, real): "recovered" means the guard ACCEPTS the
 * rewrite — NOT that it is semantically equivalent. On the live corpus the model
 * sometimes recovers a multi-step command by dropping part of it (`git rev-parse
 * HEAD && git branch …` → just `git rev-parse HEAD`). So recoveryPct is an UPPER
 * bound on true recovery. This is a further reason the loop is decision-only: we
 * would adopt the GUIDANCE LESSON (which is sound), never the specific rewrites.
 *
 * SAFETY / COST POSTURE (deliberate):
 *  - This VERIFIES and DECIDES; it never applies a lesson to the live agent.
 *  - The LLM rewrite is an INJECTED dependency. This module holds no Brain and makes
 *    no network call. The periodic scanner therefore stays deterministic and free —
 *    a live A/B (real tokens) runs ONLY from an explicit, bounded entry point.
 *  - replayVerifyLive caps how many episodes it will spend tokens on and fails open
 *    per-episode (a rewrite error counts as not-recovered, never throws).
 */
import { checkRepoCommand } from '../security/approval/repo-allowlist.js';
import {
  decideAdoption,
  type AdoptionDecision,
  type AdoptionThresholds,
  DEFAULT_ADOPTION_THRESHOLDS,
} from './repair-flywheel-verify.js';

/**
 * A repair expressed as a natural-language lesson, verified live. `extract` pulls
 * the value the lesson is about from a captured tool input; `check` is the exact,
 * deterministic prod predicate that says whether a value would be accepted.
 */
export interface GuidanceRepair {
  lessonId: string;
  tool: string;
  /** The distilled guidance the flywheel would teach the agent. */
  lesson: string;
  /** Pull the field the lesson targets from a captured input (null = out of scope). */
  extract: (input: Record<string, unknown>) => string | null;
  /** True-to-prod precondition check. `ok` = would be accepted; `reason` = why not. */
  check: (value: string) => { ok: boolean; reason?: string };
}

/**
 * Injected live rewrite: given the lesson, the refused value and the refusal reason,
 * return a rewritten value that should pass — or null to declare it IMPOSSIBLE.
 */
export type LlmRewrite = (args: { lesson: string; original: string; reason: string }) => Promise<string | null>;

export interface LiveReplayResult {
  /** Inputs the repair applies to (extract returned a value). */
  applicable: number;
  /** Applicable inputs that already pass — not genuine failures (excluded from rate). */
  alreadyOk: number;
  /** Genuine failures the rewrite converted into an accepted value. */
  recovered: number;
  /** Genuine failures the model declared IMPOSSIBLE (or the rewrite errored). */
  impossible: number;
  /** recovered / (applicable - alreadyOk), 0..100. */
  recoveryPct: number;
  /** == applicable — lets decideAdoption() treat this like a ReplayVerifyResult. */
  tried: number;
  /** Per-episode detail, for logging/human review before any adoption. */
  episodes: Array<{ original: string; reason: string; rewrite: string | null; recovered: boolean }>;
}

export interface LiveReplayOpts {
  /** Hard cap on episodes that spend tokens (cost ceiling). Default 40. */
  maxEpisodes?: number;
}

/** The distilled lesson for the repo-exec metacharacter cluster — single source of truth. */
export const EXEC_REPO_GUIDANCE_LESSON = [
  'When you run system.exec with target:"repo", the command goes through a read-only',
  'repo sandbox that runs ONE plain command with NO shell features: no pipes (|),',
  'no chaining (; && ||), no redirects (< >), no substitution ($ ` ()), no globs (* ?).',
  'It also allows only a small read-only allowlist — rg/ripgrep, ls, wc, git (status/log/',
  'diff/…), pnpm/npm (test/lint/build) — and cat is NOT allowed (use rg or ls).',
  'So: to search, use one `rg` command; to list, use `ls`; never combine steps with',
  'operators. If the task needs pipes, multiple steps, writing, or a non-allowlisted',
  'binary (pm2, bash, node -e, mkdir), do NOT use target:"repo" — drop target to use the',
  'general sandbox, or use the dedicated tool.',
].join(' ');

/**
 * Build the rewrite prompt. Exported so the live entry point and tests share exactly
 * the same instruction. Pure.
 */
export function buildRewritePrompt(lesson: string, original: string, reason: string): string {
  return [
    'A read-only repo sandbox REFUSED a shell command. Repair it, following this lesson:',
    '',
    lesson,
    '',
    `Refused command:\n${original}`,
    `Refusal reason: ${reason}`,
    '',
    'Rewrite it as ONE plain command with the SAME read-only intent that the sandbox would',
    'accept. If that is impossible (it writes, restarts a service, needs pipes/multiple steps,',
    'or a non-allowlisted binary), reply with exactly: IMPOSSIBLE',
    'Reply with ONLY the rewritten command on one line, or IMPOSSIBLE. No backticks, no prose.',
  ].join('\n');
}

/**
 * Normalize a raw model reply into a rewritten command or null (IMPOSSIBLE). Pure —
 * strips backticks/fences, takes the first non-empty line, treats IMPOSSIBLE/empty as null.
 */
export function parseRewriteReply(reply: string): string | null {
  const firstLine = (reply ?? '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const stripped = firstLine.replace(/^`|`$/g, '').trim();
  if (!stripped || /^impossible$/i.test(stripped)) return null;
  return stripped;
}

/**
 * Replay captured FAILING inputs through a GUIDANCE repair using a live rewrite, and
 * measure how many the (true-to-prod) check would then accept. Fails open per-episode;
 * bounded by maxEpisodes. Never applies anything.
 */
export async function replayVerifyLive(
  failingInputs: Array<Record<string, unknown>>,
  repair: GuidanceRepair,
  rewrite: LlmRewrite,
  opts: LiveReplayOpts = {},
): Promise<LiveReplayResult> {
  const maxEpisodes = opts.maxEpisodes ?? 40;
  let applicable = 0;
  let alreadyOk = 0;
  let recovered = 0;
  let impossible = 0;
  const episodes: LiveReplayResult['episodes'] = [];

  for (const input of failingInputs) {
    const value = repair.extract(input);
    if (value == null) continue; // out of scope for this repair
    applicable += 1;

    const pre = repair.check(value);
    if (pre.ok) { alreadyOk += 1; continue; } // not a genuine failure

    if (applicable - alreadyOk > maxEpisodes) continue; // cost ceiling: count as tried, don't spend

    const reason = pre.reason ?? 'refused';
    let rewritten: string | null = null;
    try {
      rewritten = await rewrite({ lesson: repair.lesson, original: value, reason });
    } catch {
      rewritten = null; // fail open — an errored rewrite is simply not a recovery
    }
    const ok = rewritten != null && rewritten !== value && repair.check(rewritten).ok;
    if (ok) recovered += 1;
    else if (rewritten == null) impossible += 1;
    episodes.push({ original: value, reason, rewrite: rewritten, recovered: ok });
  }

  const genuine = applicable - alreadyOk;
  return {
    applicable,
    alreadyOk,
    recovered,
    impossible,
    recoveryPct: genuine > 0 ? Math.round((1000 * recovered) / genuine) / 10 : 0,
    tried: applicable,
    episodes,
  };
}

/** decideAdoption over a live result (shape-compatible with ReplayVerifyResult). */
export function decideLiveAdoption(
  r: LiveReplayResult,
  thresholds: AdoptionThresholds = DEFAULT_ADOPTION_THRESHOLDS,
): AdoptionDecision {
  return decideAdoption({ tried: r.tried, alreadyOk: r.alreadyOk, recovered: r.recovered, recoveryPct: r.recoveryPct }, thresholds);
}

/**
 * The exec-metachar guidance repair, wired to the REAL repo-exec guard. `extract`
 * only picks up system.exec invocations that targeted the repo sandbox (target:"repo")
 * — the only ones the guard governs — so the recovery metric stays honest.
 */
export function makeExecRepoRepair(lesson: string = EXEC_REPO_GUIDANCE_LESSON): GuidanceRepair {
  return {
    lessonId: 'exec-repo-readonly-metachars',
    tool: 'system.exec',
    lesson,
    extract: (input) => {
      const cmd = input['command'];
      const target = input['target'];
      return typeof cmd === 'string' && target === 'repo' ? cmd : null;
    },
    check: (value) => {
      const m = checkRepoCommand(value);
      return { ok: m.allowed, reason: m.reason };
    },
  };
}
