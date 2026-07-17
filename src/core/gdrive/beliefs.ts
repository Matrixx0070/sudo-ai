/**
 * @file gdrive/beliefs.ts
 * @description F22 (belief maintenance) + F23 (spaced re-validation).
 *
 * The beliefs graph maps belief -> source citations (fileId@revisionId).
 * Producers: inbox ingestion (F1) registers a belief per ingested file;
 * corrections and mirror snapshots can add more. The changes feed flags
 * dependents stale on source edits, orphaned on deletions. Spaced
 * re-validation walks due beliefs on the ladder 7 -> 30 -> 90 -> 365 days
 * (doubling on pass, capped) and feeds validationState into the epistemic
 * ranking rider.
 *
 * Persistence: data/gdrive/beliefs-graph.json (zone-2; included in the F2
 * checkpoint snapshot).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import {
  scoreMemory,
  type ValidationState,
  type EpistemicTrustTier,
  type EpistemicAdjuster,
} from '../memory/epistemic-score.js';

const log = createLogger('gdrive:beliefs');

/** Review ladder in days (F23); interval doubles on pass past the last rung. */
export const REVIEW_LADDER_DAYS = [7, 30, 90, 365] as const;
const MAX_INTERVAL_DAYS = 730;

export interface Belief {
  id: string; // e.g. "gdrive-<fileId>" (matches the provenance memory id)
  /** Chunk path prefix the belief's memories live under (epistemic adjuster key). */
  chunkPathPrefix: string;
  sources: Array<{ fileId: string; revisionId?: string }>;
  trustTier: EpistemicTrustTier;
  state: ValidationState;
  confidence: number; // 0..1, decays on stale
  createdAt: string;
  reviewDue: string; // ISO
  intervalIdx: number; // index into REVIEW_LADDER_DAYS (or beyond = doubling)
  intervalDays: number;
  /** Set when queued for dream-cycle re-derivation (F12 consumes). */
  rederiveQueued?: boolean;
}

export interface BeliefsGraph {
  schemaVersion: 1;
  beliefs: Belief[];
}

export function beliefsGraphPath(): string {
  return dataPath('gdrive', 'beliefs-graph.json');
}

export function loadBeliefs(): BeliefsGraph {
  try {
    const parsed = JSON.parse(readFileSync(beliefsGraphPath(), 'utf-8')) as BeliefsGraph;
    return { schemaVersion: 1, beliefs: parsed.beliefs ?? [] };
  } catch {
    return { schemaVersion: 1, beliefs: [] };
  }
}

export function saveBeliefs(graph: BeliefsGraph): void {
  const p = beliefsGraphPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(graph, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** Register (or refresh) a belief at ingestion time (F1 calls this). */
export function upsertBelief(
  graph: BeliefsGraph,
  params: {
    id: string;
    chunkPathPrefix: string;
    sources: Array<{ fileId: string; revisionId?: string }>;
    trustTier: EpistemicTrustTier;
    now?: string;
  },
): Belief {
  const now = params.now ?? new Date().toISOString();
  const existing = graph.beliefs.find((b) => b.id === params.id);
  const intervalDays = REVIEW_LADDER_DAYS[0];
  if (existing) {
    existing.sources = params.sources;
    existing.trustTier = params.trustTier;
    existing.state = 'fresh';
    existing.confidence = 1;
    existing.reviewDue = addDays(now, intervalDays);
    existing.intervalIdx = 0;
    existing.intervalDays = intervalDays;
    existing.rederiveQueued = false;
    return existing;
  }
  const belief: Belief = {
    id: params.id,
    chunkPathPrefix: params.chunkPathPrefix,
    sources: params.sources,
    trustTier: params.trustTier,
    state: 'fresh',
    confidence: 1,
    createdAt: now,
    reviewDue: addDays(now, intervalDays),
    intervalIdx: 0,
    intervalDays,
  };
  graph.beliefs.push(belief);
  return belief;
}

// ---------------------------------------------------------------------------
// F22 — change/delete propagation
// ---------------------------------------------------------------------------

export interface ChangeImpact {
  staled: string[];
  orphaned: string[];
}

/** A cited source changed: flag dependents stale + decay confidence + queue re-derive. */
export function flagSourceChanged(graph: BeliefsGraph, fileId: string): string[] {
  const hit: string[] = [];
  for (const b of graph.beliefs) {
    if (b.sources.some((s) => s.fileId === fileId) && b.state !== 'deprecated') {
      b.state = 'stale';
      b.confidence = Math.max(0.1, b.confidence * 0.6);
      b.rederiveQueued = true;
      hit.push(b.id);
    }
  }
  return hit;
}

/** A cited source was deleted: dependents become orphaned. */
export function flagSourceDeleted(graph: BeliefsGraph, fileId: string): string[] {
  const hit: string[] = [];
  for (const b of graph.beliefs) {
    if (b.sources.some((s) => s.fileId === fileId) && b.state !== 'deprecated') {
      b.state = 'orphaned';
      b.confidence = Math.max(0.1, b.confidence * 0.4);
      b.rederiveQueued = true;
      hit.push(b.id);
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// F23 — spaced re-validation
// ---------------------------------------------------------------------------

export function dueForReview(graph: BeliefsGraph, now: string = new Date().toISOString()): Belief[] {
  return graph.beliefs.filter(
    (b) => b.state !== 'deprecated' && b.reviewDue <= now,
  );
}

/** Passed re-validation: refresh + extend the interval (ladder, then doubling). */
export function recordValidationPass(belief: Belief, now: string = new Date().toISOString()): void {
  belief.state = 'fresh';
  belief.confidence = Math.min(1, belief.confidence + 0.2);
  belief.intervalIdx += 1;
  belief.intervalDays =
    belief.intervalIdx < REVIEW_LADDER_DAYS.length
      ? REVIEW_LADDER_DAYS[belief.intervalIdx]!
      : Math.min(MAX_INTERVAL_DAYS, belief.intervalDays * 2);
  belief.reviewDue = addDays(now, belief.intervalDays);
  belief.rederiveQueued = false;
}

/** Failed re-validation: deprecate or queue re-derivation. */
export function recordValidationFail(
  belief: Belief,
  mode: 'deprecate' | 'rederive',
  now: string = new Date().toISOString(),
): void {
  if (mode === 'deprecate') {
    belief.state = 'deprecated';
    belief.confidence = Math.min(belief.confidence, 0.2);
  } else {
    belief.state = 'stale';
    belief.rederiveQueued = true;
    belief.confidence = Math.max(0.1, belief.confidence * 0.6);
  }
  // Back to the bottom of the ladder either way.
  belief.intervalIdx = 0;
  belief.intervalDays = REVIEW_LADDER_DAYS[0];
  belief.reviewDue = addDays(now, belief.intervalDays);
}

/**
 * One re-validation sweep: for each due belief, compare each cited source's
 * current headRevisionId against the citation. Same revision => pass;
 * changed => stale + queue; missing/trashed => orphaned.
 */
export async function runRevalidationSweep(
  graph: BeliefsGraph,
  getFileMeta: (fileId: string) => Promise<{ headRevisionId?: string; trashed?: boolean } | null>,
  now: string = new Date().toISOString(),
): Promise<{ passed: string[]; staled: string[]; orphaned: string[] }> {
  const out = { passed: [] as string[], staled: [] as string[], orphaned: [] as string[] };
  for (const belief of dueForReview(graph, now)) {
    let verdict: 'pass' | 'stale' | 'orphaned' = 'pass';
    for (const source of belief.sources) {
      const meta = await getFileMeta(source.fileId);
      if (!meta || meta.trashed) {
        verdict = 'orphaned';
        break;
      }
      if (source.revisionId && meta.headRevisionId && meta.headRevisionId !== source.revisionId) {
        verdict = 'stale';
      }
    }
    if (verdict === 'pass') {
      recordValidationPass(belief, now);
      out.passed.push(belief.id);
    } else if (verdict === 'stale') {
      recordValidationFail(belief, 'rederive', now);
      out.staled.push(belief.id);
    } else {
      belief.state = 'orphaned';
      belief.confidence = Math.max(0.1, belief.confidence * 0.4);
      belief.rederiveQueued = true;
      belief.reviewDue = addDays(now, REVIEW_LADDER_DAYS[0]);
      out.orphaned.push(belief.id);
    }
  }
  if (out.passed.length || out.staled.length || out.orphaned.length) {
    log.info(out, 're-validation sweep complete');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Epistemic adjuster (feeds the retrieval rider)
// ---------------------------------------------------------------------------

/**
 * Build a path-prefix-keyed adjuster from the graph. Chunks under a belief's
 * prefix get trustWeight × validationState applied via scoreMemory; unknown
 * paths stay neutral.
 */
export function buildEpistemicAdjuster(graph: BeliefsGraph): EpistemicAdjuster {
  // Longest-prefix match wins.
  const entries = [...graph.beliefs].sort(
    (a, b) => b.chunkPathPrefix.length - a.chunkPathPrefix.length,
  );
  return (chunkPath, baseScore) => {
    const belief = entries.find((b) => chunkPath.startsWith(b.chunkPathPrefix));
    if (!belief) return baseScore;
    return scoreMemory(baseScore, { trustTier: belief.trustTier, validationState: belief.state });
  };
}

/** Atlas/report surface: stale + orphaned beliefs needing attention. */
export function unhealthyBeliefs(graph: BeliefsGraph): Belief[] {
  return graph.beliefs.filter((b) => b.state === 'stale' || b.state === 'orphaned');
}

/** Test/ops probe. */
export function hasBeliefsGraph(): boolean {
  return existsSync(beliefsGraphPath());
}
