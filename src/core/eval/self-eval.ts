/**
 * @file self-eval.ts
 * @description Point the eval harness at SUDO's OWN behaviour (gap #4).
 *
 * The skill-eval harness proves SUDO can measure a change; it was only ever
 * pointed at skills. This closes the "hypothesise → implement → eval →
 * keep/revert improvements to MYSELF" loop for the cheapest, safest lever:
 * a candidate addition to SUDO's own system prompt (a behaviour directive).
 *
 * runSelfEval() A/Bs the SAME task set twice — once as-is (baseline), once with
 * the candidate directive prepended as a system message — scores both, and
 * names keep / revert / inconclusive from the pass-rate delta. Adoption is a
 * separate, gated step: a kept directive is appended to a durable store that the
 * system-prompt assembler injects (mirroring the existing Learned Repair Hints
 * path). Default is measure-and-recommend only — SUDO_SELF_EVAL_ADOPT=1 is
 * required before an adopted directive can ever change the live prompt, so the
 * loop cannot silently rewrite SUDO's behaviour.
 *
 * Honest scope: this reorganises the fixed model's instructions based on
 * measured outcomes. It does not change the model. It makes SUDO
 * self-correcting, not smarter.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('eval:self-eval');

/** Minimal brain contract (matches EvalBrain / ctx.config.brain). */
export interface SelfEvalBrain {
  call(opts: { messages: Array<{ role: string; content: string }>; source?: string }): Promise<{ content: string }>;
}

export interface SelfEvalTask {
  prompt: string;
  /** Case-insensitive substrings that ALL must appear for a pass. Preferred. */
  mustInclude?: string[];
  /** Convenience: single expected substring (case-insensitive). */
  expect?: string;
}

export interface SelfEvalResult {
  directive: string;
  n: number;
  baselinePass: number;   // 0..1
  candidatePass: number;  // 0..1
  passDelta: number;      // candidate - baseline
  verdict: 'keep' | 'revert' | 'inconclusive';
  scored: boolean;        // false when no task had a pass criterion (weak signal)
  detail: Array<{ prompt: string; baseOk: boolean; candOk: boolean }>;
}

export interface RunSelfEvalOptions {
  directive: string;
  tasks: SelfEvalTask[];
  /** Min pass-rate improvement to call it a keep (default 0.15). */
  keepThreshold?: number;
  source?: string;
}

function passCriteria(task: SelfEvalTask): string[] | null {
  if (task.mustInclude && task.mustInclude.length) return task.mustInclude;
  if (task.expect) return [task.expect];
  return null;
}

function judge(response: string, criteria: string[] | null): { ok: boolean; scored: boolean } {
  if (!criteria) return { ok: response.trim().length > 0, scored: false };
  const lc = response.toLowerCase();
  return { ok: criteria.every((c) => lc.includes(c.toLowerCase())), scored: true };
}

/**
 * A/B a candidate behaviour directive against baseline on a task set.
 * Deterministic scoring via substring criteria (no judge cost); falls back to
 * non-empty when a task carries no criterion (flagged scored:false).
 */
export async function runSelfEval(brain: SelfEvalBrain, opts: RunSelfEvalOptions): Promise<SelfEvalResult> {
  const { directive, tasks } = opts;
  const keepThreshold = opts.keepThreshold ?? 0.15;
  const source = opts.source ?? 'self-eval';
  if (!directive || !directive.trim()) throw new Error('runSelfEval: directive is required');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('runSelfEval: at least one task is required');

  let basePass = 0, candPass = 0, anyScored = false;
  const detail: SelfEvalResult['detail'] = [];

  for (const task of tasks) {
    const criteria = passCriteria(task);
    const [baseResp, candResp] = await Promise.all([
      brain.call({ messages: [{ role: 'user', content: task.prompt }], source }),
      brain.call({ messages: [{ role: 'system', content: directive }, { role: 'user', content: task.prompt }], source }),
    ]);
    const base = judge(baseResp.content ?? '', criteria);
    const cand = judge(candResp.content ?? '', criteria);
    anyScored = anyScored || base.scored;
    if (base.ok) basePass++;
    if (cand.ok) candPass++;
    detail.push({ prompt: task.prompt.slice(0, 80), baseOk: base.ok, candOk: cand.ok });
  }

  const n = tasks.length;
  const baselinePass = basePass / n;
  const candidatePass = candPass / n;
  const passDelta = candidatePass - baselinePass;
  const verdict: SelfEvalResult['verdict'] =
    passDelta >= keepThreshold ? 'keep' : passDelta <= -keepThreshold ? 'revert' : 'inconclusive';

  log.info({ directive: directive.slice(0, 60), n, baselinePass, candidatePass, passDelta, verdict, scored: anyScored }, 'self-eval complete');
  return { directive, n, baselinePass, candidatePass, passDelta, verdict, scored: anyScored, detail };
}

// ---------------------------------------------------------------------------
// Adopted-directive store (the keep/revert read-path) — mirrors the Learned
// Repair Hints pattern. Gated: getAdoptedDirectives() returns [] unless
// SUDO_SELF_EVAL_ADOPT=1, so the default build's system prompt is byte-stable.
// ---------------------------------------------------------------------------

interface AdoptedDirective { directive: string; adoptedAt: string; evidence: string }

const STORE_PATH = path.join(DATA_DIR, 'learned-directives.json');
const MAX_DIRECTIVES = 12;
const MAX_DIRECTIVE_LEN = 300;
let cache: { at: number; list: AdoptedDirective[] } | null = null;
const CACHE_MS = 60_000;

export function isSelfEvalAdoptEnabled(): boolean {
  return process.env['SUDO_SELF_EVAL_ADOPT'] === '1';
}

function loadStore(): AdoptedDirective[] {
  try {
    if (!existsSync(STORE_PATH)) return [];
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw.filter((d) => d && typeof d.directive === 'string') : [];
  } catch { return []; }
}

/** Directive strings injected into the live system prompt RIGHT NOW ([] if gated off). */
export function getAdoptedDirectives(nowMs: number = Date.now()): string[] {
  if (!isSelfEvalAdoptEnabled()) return [];
  if (cache && nowMs - cache.at < CACHE_MS) return cache.list.map((d) => d.directive);
  const list = loadStore().slice(-MAX_DIRECTIVES);
  cache = { at: nowMs, list };
  return list.map((d) => d.directive);
}

/**
 * Persist a kept directive. Only takes effect on the live prompt when
 * SUDO_SELF_EVAL_ADOPT=1 (getAdoptedDirectives gates on it). Returns false if
 * adoption is disabled or the directive is a duplicate/too long.
 */
export function adoptDirective(directive: string, evidence: string): boolean {
  if (!isSelfEvalAdoptEnabled()) return false;
  const d = directive.trim();
  if (!d || d.length > MAX_DIRECTIVE_LEN) return false;
  const list = loadStore();
  if (list.some((x) => x.directive === d)) return false;
  list.push({ directive: d, adoptedAt: new Date().toISOString(), evidence: evidence.slice(0, 200) });
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(list.slice(-MAX_DIRECTIVES), null, 2), 'utf-8');
    cache = null;
    log.info({ directive: d.slice(0, 60) }, 'self-eval: directive adopted into learned-directives store');
    return true;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'self-eval: adopt write failed');
    return false;
  }
}

/** Test/diagnostic — clears the in-memory cache. */
export function __resetSelfEvalCacheForTests(): void { cache = null; }
