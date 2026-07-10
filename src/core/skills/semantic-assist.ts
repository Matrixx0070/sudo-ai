/**
 * @file semantic-assist.ts
 * @description Recall layer for skill activation — semantic match on the
 * cases deterministic phrase matching cannot reach.
 *
 * skill.trigger-eval measured the deterministic matcher's ceiling at ~50-75%
 * accuracy on near-miss sets (#665): the dominant failure is INTENT WITHOUT
 * KEYWORD ("give me the short version of this thread" carries no "tldr"/
 * "summarize" token). This module runs ONLY when the deterministic matcher
 * found nothing: it embeds the message with the local MiniLM (zero API cost,
 * shared ONNX pipeline with memory search) and compares against cached
 * per-skill anchor vectors (trigger phrases; see {@link anchorTexts} for why
 * descriptions are deliberately NOT anchors).
 *
 * Calibration against the real model (2026-07-10): summarization-intent
 * near-misses score 0.38-0.44 cosine vs true negatives at 0.05-0.20, so the
 * default threshold is 0.35 (SUDO_SKILL_SEMANTIC_THRESHOLD overrides).
 * Recall-only by design: a deterministic fire is never vetoed, so the
 * keyword-as-topic false-fire class ("what does tl;dr stand for") is
 * untouched here — that is a separate precision slice.
 *
 * Turn-latency guarantees: the whole selection races a wall-clock budget
 * (SUDO_SKILL_SEMANTIC_BUDGET_MS, default 400ms) — on timeout the turn
 * proceeds without skills while the embed/model-load continues in the
 * background and warms the cache for later turns. A failed query embed
 * (model load broken: offline box, missing weights) opens a cooldown so the
 * load is NOT retried on every miss turn. Fail-open everywhere: embedder
 * unavailable, embed null, timeout, or any throw degrades to "no semantic
 * match". Kill-switch SUDO_SKILL_SEMANTIC_ASSIST=0.
 */

import { createLogger } from '../shared/logger.js';
import type { ActivatableSkill, SkillActivation } from './skill-activator.js';
import { effectiveTriggers } from './skill-activator.js';

const log = createLogger('skills:semantic-assist');

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_SKILL_SEMANTIC_ASSIST=0 disables. */
export function isSemanticAssistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKILL_SEMANTIC_ASSIST'] !== '0';
}

/** Cosine threshold for a semantic fire (default 0.35, clamped 0.05..0.95). */
export function semanticThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SUDO_SKILL_SEMANTIC_THRESHOLD']);
  if (!Number.isFinite(n)) return 0.35;
  return Math.min(Math.max(n, 0.05), 0.95);
}

/**
 * Wall-clock budget for one semantic selection on the turn path (default
 * 400ms, clamped ≤10s). 0 disables the budget — used by eval harnesses that
 * want exact results rather than turn-latency guarantees.
 */
export function semanticBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SUDO_SKILL_SEMANTIC_BUDGET_MS']);
  if (!Number.isFinite(n) || n < 0) return 400;
  return Math.min(Math.floor(n), 10_000);
}

/** Retry cooldown after a failed query embed (model load broken). */
const EMBED_FAIL_COOLDOWN_MS = 300_000;

/**
 * Semantic intent inference is for HUMAN traffic. Internal scheduled-run
 * peers (`cron:*`, the crash-safe.ts convention) send agent-generated task
 * prompts where persona-skill injection is pure overhead — they were 580 of
 * the 654 would-fires in the 2026-07-10 real-traffic measurement.
 */
export function semanticAllowedForPeer(peerId: string | undefined | null): boolean {
  return !(typeof peerId === 'string' && peerId.startsWith('cron:'));
}

// ---------------------------------------------------------------------------
// Embedder surface (structural — LocalEmbeddingProvider satisfies it)
// ---------------------------------------------------------------------------

export interface AssistEmbedder {
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

let _defaultEmbedder: AssistEmbedder | null = null;
let _embedFailUntil = 0;

/** Lazy shared LocalEmbeddingProvider (its ONNX pipeline is module-shared). */
async function defaultEmbedder(): Promise<AssistEmbedder | null> {
  if (_defaultEmbedder) return _defaultEmbedder;
  try {
    const { LocalEmbeddingProvider } = await import('../memory/local-embeddings.js');
    const provider = new LocalEmbeddingProvider();
    if (!provider.isAvailable) return null;
    _defaultEmbedder = provider;
    return provider;
  } catch (err) {
    log.debug({ err: String(err) }, 'Local embedder unavailable — semantic assist off');
    return null;
  }
}

/** Test hook: reset the cached default embedder, cooldown, and anchor cache. */
export function __resetSemanticAssist(): void {
  _defaultEmbedder = null;
  _embedFailUntil = 0;
  anchorCache.clear();
}

// ---------------------------------------------------------------------------
// Anchor cache
// ---------------------------------------------------------------------------

/**
 * Anchor texts a skill is matched against: its trigger phrases ONLY.
 * Descriptions were anchors in the first cut and turned out to be the junk
 * source — measured on 895 real deterministic-miss messages (2026-07-10):
 * description embeddings (long prose) sat at 0.35-0.45 cosine against most
 * paragraph-length messages, would-firing 654/895 (580 of them internal cron
 * prompts); trigger-only anchors fire 63/895 with the labeled genuine-intent
 * recall set fully preserved (8/8). Sharp phrases in, broad prose out.
 */
export function anchorTexts(skill: ActivatableSkill): string[] {
  return effectiveTriggers(skill);
}

interface AnchorEntry {
  /** NUL-joined anchor texts — invalidates the cache when triggers change. */
  key: string;
  texts: string[];
  vecs: Float32Array[];
}

const anchorCache = new Map<string, AnchorEntry>();

async function anchorsFor(skill: ActivatableSkill, embedder: AssistEmbedder): Promise<AnchorEntry | null> {
  const texts = anchorTexts(skill);
  if (texts.length === 0) return null;
  const key = texts.join('\u0000');
  const cached = anchorCache.get(skill.name);
  if (cached && cached.key === key) return cached;
  const vecs = await embedder.embedBatch(texts);
  const kept: { text: string; vec: Float32Array }[] = [];
  texts.forEach((t, i) => { const v = vecs[i]; if (v) kept.push({ text: t, vec: v }); });
  if (kept.length === 0) return null;
  const entry: AnchorEntry = { key, texts: kept.map((k) => k.text), vecs: kept.map((k) => k.vec) };
  anchorCache.set(skill.name, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Dot product; embeddings from the local provider are already normalized.
 * Length mismatch (only possible with an injected embedder) scores 0 rather
 * than returning a truncated pseudo-cosine.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

async function selectSemanticSkillInner(
  query: string,
  skills: readonly ActivatableSkill[],
  threshold: number,
  embedder: AssistEmbedder,
): Promise<SkillActivation | null> {
  const qv = await embedder.embed(query);
  if (!qv) {
    _embedFailUntil = Date.now() + EMBED_FAIL_COOLDOWN_MS;
    log.warn({ cooldownMs: EMBED_FAIL_COOLDOWN_MS }, 'Query embed failed — semantic assist cooling down');
    return null;
  }

  // Anchor batches run concurrently; the ONNX session serializes inference
  // internally, so this bounds wall-clock at ~one pass instead of N awaits.
  const anchorEntries = await Promise.all(skills.map((s) => anchorsFor(s, embedder)));

  let best: { skill: ActivatableSkill; text: string; sim: number } | null = null;
  skills.forEach((skill, si) => {
    const anchors = anchorEntries[si];
    if (!anchors) return;
    for (let i = 0; i < anchors.vecs.length; i++) {
      const sim = cosine(qv, anchors.vecs[i]!);
      if (sim >= threshold && (!best || sim > best.sim)) {
        best = { skill, text: anchors.texts[i]!, sim };
      }
    }
  });
  if (!best) return null;
  const b: { skill: ActivatableSkill; text: string; sim: number } = best;
  return {
    skill: b.skill,
    phrase: b.text,
    // Cosine × 1000 — NOT comparable with deterministic phrase scores; the
    // two paths never compete (semantic runs only when deterministic found
    // nothing), so this is a log-readability value, not a ranking key.
    score: Math.round(b.sim * 1000),
    semantic: true,
    similarity: b.sim,
  };
}

/**
 * Best semantic match across skills, or null when nothing clears the
 * threshold, the budget expires, or the embedder is unavailable/cooling
 * down. At most ONE skill fires per message — the assist is a recall net,
 * not a ranking system.
 */
export async function selectSemanticSkill(
  query: string,
  skills: readonly ActivatableSkill[],
  opts: { embedder?: AssistEmbedder; threshold?: number; budgetMs?: number } = {},
): Promise<SkillActivation | null> {
  if (Date.now() < _embedFailUntil) return null;
  const threshold = opts.threshold ?? semanticThreshold();
  const embedder = opts.embedder ?? await defaultEmbedder();
  if (!embedder) return null;

  const budget = opts.budgetMs ?? semanticBudgetMs();
  const work = selectSemanticSkillInner(query, skills, threshold, embedder);
  if (budget === 0) return work;

  // Race the budget; on timeout the turn proceeds skill-less while `work`
  // keeps running in the background, warming the anchor cache (and the
  // model) for later turns. Swallow late rejections so a lost race can
  // never surface as an unhandled rejection.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.info({ budgetMs: budget }, 'Semantic assist over budget — turn proceeds, warmup continues');
      resolve(null);
    }, budget);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
