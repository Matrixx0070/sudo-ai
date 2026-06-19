/**
 * @file chunk-contradiction.ts
 * @description Semantic contradiction detection + supersession for the free-text
 * `chunks` store (audit follow-up #7).
 *
 * The structured-memory store already supersedes conflicting facts via a
 * deterministic (type, name) key (#295). The free-text chunks store had no such
 * mechanism: it dedups only byte-identical text, so a new chunk that CONTRADICTS
 * a stored one ("prefers tabs" vs the earlier "prefers spaces") simply coexists,
 * with no winner chosen — stale facts surface in recall forever.
 *
 * Byte-identity and even cosine similarity alone cannot distinguish a harmless
 * restatement ("prefers spaces" ≈ "likes using spaces", high cosine, NOT a
 * conflict) from a true contradiction ("prefers spaces" vs "prefers tabs", also
 * high cosine, IS a conflict). So detection is two-stage:
 *
 *   1. Embedding cosine narrows all active chunks to a few about the SAME subject.
 *   2. An opposition judge (LLM) decides, per candidate, whether the incoming
 *      chunk actually CONTRADICTS it. Only then is the older chunk superseded.
 *
 * Both dependencies are injected so this module is pure, testable without any
 * network, and degrades gracefully: no embeddings (no API key) → no candidates →
 * no-op; judge throwing → that candidate is skipped, never blocks the write.
 *
 * Opt-in via SUDO_CHUNK_CONTRADICT=1 (default OFF preserves prior accrete
 * behaviour, exactly like SUDO_MEMORY_SUPERSEDE for structured facts).
 */

import type { MindDB } from './db.js';
import type { MemoryChunk } from './types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:chunk-contradiction');

/** Whether semantic contradiction resolution is enabled (read per-call). */
export function isChunkContradictionEnabled(): boolean {
  return process.env['SUDO_CHUNK_CONTRADICT'] === '1';
}

/**
 * Decides whether `incoming` semantically contradicts `existing`. Returns true
 * only for genuine opposition (same subject, incompatible value) — NOT for
 * restatement, elaboration, or unrelated text. Backed by an LLM in production.
 */
export type ContradictionJudge = (incoming: string, existing: string) => Promise<boolean>;

/** Injected dependencies for {@link resolveChunkContradictions}. */
export interface ChunkContradictionDeps {
  db: MindDB;
  /** Embed text → vector, or null when embeddings are unavailable (degrade to no-op). */
  embed: (text: string) => Promise<Float32Array | null>;
  /** Opposition judge — only consulted for high-similarity candidates. */
  judge: ContradictionJudge;
}

export interface ContradictionOptions {
  /** Minimum cosine similarity for a candidate to be "about the same subject". */
  simThreshold?: number;
  /** Max active chunks scanned for candidates (bounds embed calls). */
  maxCandidates?: number;
  /** Max candidates actually sent to the judge per incoming chunk (bounds LLM calls). */
  maxJudged?: number;
}

/**
 * Default stage-1 cosine cutoff. Lowered from the original 0.83 guess after
 * calibration against real embeddings (scripts/calibrate-chunk-threshold.mjs)
 * over labeled contradiction / restatement / unrelated chunk pairs:
 *
 *   model                    100%-recall thr   FP there   note
 *   nomic-embed-text (local) ~0.62             ~15%       classes overlap
 *   gemini-embedding-001     ~0.72             ~1%        cleaner separation
 *   text-embedding-3-small   unmeasured        —          prod key quota-dead
 *
 * 0.83 dropped ~50% of true same-subject pairs on nomic and ~18% on gemini — a
 * stage-1 false negative silently loses a contradiction forever, whereas a false
 * positive is only a bounded extra judge call (the judge is the real filter, and
 * maxJudged caps the cost). So we favor recall. The cutoff is MODEL-SPECIFIC:
 * override per deployment via SUDO_CHUNK_CONTRADICT_SIM to match the embedding
 * model actually wired in (see resolveSimThreshold).
 */
const DEFAULT_SIM_THRESHOLD = 0.65;

const DEFAULTS: Required<ContradictionOptions> = {
  simThreshold: DEFAULT_SIM_THRESHOLD,
  maxCandidates: 200,
  maxJudged: 5,
};

/**
 * Resolve the stage-1 cosine threshold: explicit option > SUDO_CHUNK_CONTRADICT_SIM
 * env (clamped to [0,1]) > DEFAULT_SIM_THRESHOLD. A malformed/out-of-range env
 * value falls back to the default rather than silently disabling detection.
 */
export function resolveSimThreshold(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) {
    return Math.min(1, Math.max(0, explicit));
  }
  const raw = process.env['SUDO_CHUNK_CONTRADICT_SIM'];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return DEFAULT_SIM_THRESHOLD;
}

export interface ContradictionResult {
  /** Ids of previously-active chunks now superseded by the incoming chunk. */
  supersededIds: number[];
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 on a zero vector or a
 * length mismatch (degrade rather than throw).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Detect chunks that the freshly-stored `incoming` chunk contradicts and mark
 * them superseded. No-op (returns empty) when disabled, when embeddings are
 * unavailable, or when nothing is semantically close enough to judge.
 *
 * Never throws: every dependency failure is swallowed so a memory write is never
 * blocked by contradiction resolution (fail-open, matching the rest of memory).
 */
export async function resolveChunkContradictions(
  incoming: MemoryChunk,
  deps: ChunkContradictionDeps,
  options: ContradictionOptions = {},
): Promise<ContradictionResult> {
  const empty: ContradictionResult = { supersededIds: [] };
  if (!isChunkContradictionEnabled()) return empty;

  // simThreshold resolves through the env override + clamp; other knobs take the
  // explicit option then the default.
  const opts = {
    ...DEFAULTS,
    ...options,
    simThreshold: resolveSimThreshold(options.simThreshold),
  };

  try {
    const incomingVec = await deps.embed(incoming.text);
    if (!incomingVec) return empty; // no embeddings → cannot judge subject overlap

    // Stage 1: cosine-rank active chunks to find same-subject candidates.
    const actives = deps.db.getActiveChunks(opts.maxCandidates)
      .filter((c) => c.id !== incoming.id);

    const scored: Array<{ chunk: MemoryChunk; sim: number }> = [];
    for (const cand of actives) {
      const vec = await deps.embed(cand.text); // cached after first embed — cheap
      if (!vec) continue;
      const sim = cosineSimilarity(incomingVec, vec);
      if (sim >= opts.simThreshold) scored.push({ chunk: cand, sim });
    }

    scored.sort((a, b) => b.sim - a.sim);
    const shortlist = scored.slice(0, opts.maxJudged);

    // Stage 2: LLM opposition judgement — supersede only true contradictions.
    const supersededIds: number[] = [];
    for (const { chunk, sim } of shortlist) {
      let contradicts: boolean;
      try {
        contradicts = await deps.judge(incoming.text, chunk.text);
      } catch (err) {
        log.warn({ candidateId: chunk.id, err: String(err) }, 'contradiction judge threw — skipping candidate');
        continue;
      }
      if (!contradicts) continue;
      if (deps.db.markChunkSuperseded(chunk.id, incoming.id)) {
        supersededIds.push(chunk.id);
        log.info(
          { supersededId: chunk.id, by: incoming.id, sim: Number(sim.toFixed(3)) },
          'chunk: superseded contradicting fact',
        );
      }
    }

    return { supersededIds };
  } catch (err) {
    log.warn({ incomingId: incoming.id, err: String(err) }, 'chunk contradiction resolution failed (non-fatal)');
    return empty;
  }
}
