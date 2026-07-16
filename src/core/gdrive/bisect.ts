/**
 * @file gdrive/bisect.ts
 * @description F9 — git-bisect over the brain.
 *
 * Blobs are immutable, so the brain's timeline IS the manifest file's Drive
 * revision history. Given an ordered good..bad revision range and a judge
 * (scripted assertion or human prompt), binary-search to the first bad
 * manifest revision and report the manifest diff (which memories changed).
 *
 * Requires revision pinning on release boundaries (F36) so the searched
 * range survives Drive's revision pruning.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { BrainKeys } from './keys.js';
import { loadVersionedManifest } from './migrations.js';
import type { BrainManifest, ManifestEntry } from './manifest.js';

const log = createLogger('gdrive:bisect');

export interface ManifestDiff {
  added: ManifestEntry[];
  removed: ManifestEntry[];
  changed: Array<{ logicalPath: string; before: ManifestEntry; after: ManifestEntry }>;
}

/** Diff two manifests by logicalPath (content identity = sha256). */
export function diffManifests(before: BrainManifest, after: BrainManifest): ManifestDiff {
  const byPath = (m: BrainManifest) => new Map(m.entries.map((e) => [e.logicalPath, e]));
  const a = byPath(before);
  const b = byPath(after);
  const diff: ManifestDiff = { added: [], removed: [], changed: [] };
  for (const [p, e] of b) {
    const prev = a.get(p);
    if (!prev) diff.added.push(e);
    else if (prev.sha256 !== e.sha256) diff.changed.push({ logicalPath: p, before: prev, after: e });
  }
  for (const [p, e] of a) if (!b.has(p)) diff.removed.push(e);
  return diff;
}

/**
 * The judge replays the recorded task (F10 bundle) against a temp brain built
 * from this manifest revision and answers "is this brain GOOD?".
 */
export type BisectJudge = (manifest: BrainManifest, revisionId: string) => Promise<boolean>;

export interface BisectResult {
  firstBadRevisionId: string;
  lastGoodRevisionId?: string;
  firstBadManifest: BrainManifest;
  lastGoodManifest?: BrainManifest;
  /** What changed between the last good and first bad brains. */
  diff?: ManifestDiff;
  judgeCalls: number;
}

/**
 * Binary-search the manifest's revision history.
 *
 * @param revisionIds chronological (oldest -> newest) revision ids delimiting
 *   the search range; the caller asserts index 0 is GOOD and the last is BAD
 *   (classic bisect precondition — verified with two extra judge calls unless
 *   `trustEndpoints`).
 */
export async function bisectBrain(
  client: DriveClient,
  manifestFileId: string,
  revisionIds: string[],
  judge: BisectJudge,
  keys: BrainKeys,
  opts: { trustEndpoints?: boolean } = {},
): Promise<BisectResult> {
  if (revisionIds.length < 2) throw new Error('bisect: need at least a good and a bad revision');

  const manifestAt = async (revisionId: string): Promise<BrainManifest> => {
    const raw = await client.revisionsGetContent(manifestFileId, revisionId);
    return loadVersionedManifest(JSON.parse(raw), keys.hmacKey);
  };

  let judgeCalls = 0;
  const judged = new Map<string, boolean>();
  const isGood = async (revisionId: string): Promise<boolean> => {
    const hit = judged.get(revisionId);
    if (hit !== undefined) return hit;
    const manifest = await manifestAt(revisionId);
    judgeCalls++;
    const verdict = await judge(manifest, revisionId);
    judged.set(revisionId, verdict);
    return verdict;
  };

  if (!opts.trustEndpoints) {
    if (!(await isGood(revisionIds[0]!))) throw new Error('bisect: range start is not GOOD');
    if (await isGood(revisionIds[revisionIds.length - 1]!)) {
      throw new Error('bisect: range end is not BAD');
    }
  }

  // Invariant: lo is GOOD, hi is BAD.
  let lo = 0;
  let hi = revisionIds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await isGood(revisionIds[mid]!)) lo = mid;
    else hi = mid;
  }

  const firstBadRevisionId = revisionIds[hi]!;
  const lastGoodRevisionId = revisionIds[lo]!;
  const firstBadManifest = await manifestAt(firstBadRevisionId);
  const lastGoodManifest = await manifestAt(lastGoodRevisionId);
  const diff = diffManifests(lastGoodManifest, firstBadManifest);
  log.info(
    { firstBadRevisionId, judgeCalls, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
    'bisect converged',
  );
  return { firstBadRevisionId, lastGoodRevisionId, firstBadManifest, lastGoodManifest, diff, judgeCalls };
}
