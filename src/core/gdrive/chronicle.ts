/**
 * @file gdrive/chronicle.ts
 * @description F31 — bitemporal chronicle + knew-at reconstruction.
 *
 * Append-only daily JSONL: {tTx, tValid?, op, memoryId, contentSha256,
 * sourceRef}. Ops are derived structurally from manifest diffs at checkpoint
 * time (add/update/deprecate per logicalPath) — every synced memory mutation
 * is captured without instrumenting the memory subsystem (which must not
 * import gdrive). Local files under data/gdrive/chronicle/, mirrored to
 * memory/chronicle/ in Drive by the daily job.
 *
 * knew-at: nearest manifest revision at-or-before the timestamp + the day's
 * chronicle delta -> a temp read-only brain view that provably excludes
 * anything learned later.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import type { BrainManifest } from './manifest.js';
import { diffManifests } from './bisect.js';
import { loadVersionedManifest } from './migrations.js';

const log = createLogger('gdrive:chronicle');

export interface ChronicleOp {
  /** Transaction time — when the brain learned it. */
  tTx: string;
  /** Valid time — when it was true in the world (when known). */
  tValid?: string;
  op: 'add' | 'update' | 'deprecate';
  memoryId: string; // logicalPath
  contentSha256: string;
  sourceRef?: string;
}

export function chronicleDir(): string {
  return dataPath('gdrive', 'chronicle');
}

function dayFile(day: string): string {
  return join(chronicleDir(), `${day}.jsonl`);
}

/** Append ops to today's local chronicle file. */
export function appendChronicle(ops: ChronicleOp[], day?: string): void {
  if (!ops.length) return;
  const d = day ?? new Date().toISOString().slice(0, 10);
  mkdirSync(chronicleDir(), { recursive: true });
  appendFileSync(dayFile(d), ops.map((o) => JSON.stringify(o)).join('\n') + '\n', { mode: 0o600 });
}

/** Derive chronicle ops from a checkpoint's manifest transition. */
export function opsFromManifestDiff(
  prev: BrainManifest | null,
  next: BrainManifest,
  tTx: string,
): ChronicleOp[] {
  if (!prev) {
    return next.entries.map((e) => ({ tTx, op: 'add' as const, memoryId: e.logicalPath, contentSha256: e.sha256 }));
  }
  const diff = diffManifests(prev, next);
  return [
    ...diff.added.map((e) => ({ tTx, op: 'add' as const, memoryId: e.logicalPath, contentSha256: e.sha256 })),
    ...diff.changed.map((c) => ({ tTx, op: 'update' as const, memoryId: c.logicalPath, contentSha256: c.after.sha256 })),
    ...diff.removed.map((e) => ({ tTx, op: 'deprecate' as const, memoryId: e.logicalPath, contentSha256: e.sha256 })),
  ];
}

/** Read local chronicle ops in [fromDay, toDay] inclusive. */
export function readChronicle(fromDay: string, toDay: string): ChronicleOp[] {
  if (!existsSync(chronicleDir())) return [];
  const out: ChronicleOp[] = [];
  for (const f of readdirSync(chronicleDir()).sort()) {
    const day = f.replace(/\.jsonl$/, '');
    if (day < fromDay || day > toDay) continue;
    for (const line of readFileSync(join(chronicleDir(), f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ChronicleOp);
      } catch {
        /* skip torn line */
      }
    }
  }
  return out;
}

/** Mirror any not-yet-uploaded day files to Drive memory/chronicle/. */
export async function uploadChronicle(client: DriveClient, folders: FolderIdMap): Promise<number> {
  const folderId = folders['memory/chronicle'];
  if (!folderId || !existsSync(chronicleDir())) return 0;
  const remote = new Set((await client.listChildren(folderId)).map((f) => f.name));
  const today = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  let uploaded = 0;
  for (const f of readdirSync(chronicleDir()).sort()) {
    // Today's file is still growing — upload only closed days.
    if (remote.has(f) || f === today) continue;
    await client.filesCreate(
      { name: f, parents: [folderId] },
      { mimeType: 'application/jsonl', body: readFileSync(join(chronicleDir(), f), 'utf-8') },
    );
    uploaded++;
  }
  if (uploaded) log.info({ uploaded }, 'chronicle days uploaded');
  return uploaded;
}

// ---------------------------------------------------------------------------
// knew-at
// ---------------------------------------------------------------------------

export interface KnewAtView {
  /** The manifest revision that was current at the timestamp. */
  manifest: BrainManifest;
  revisionId: string;
  /** Chronicle ops between that revision and the timestamp (the delta). */
  delta: ChronicleOp[];
  /** logicalPaths known at the timestamp (manifest ∪ delta adds − deprecates). */
  knownPaths: Set<string>;
}

/**
 * Reconstruct what the brain knew at `timestamp` from the manifest's revision
 * history + the chronicle delta. Read-only; never touches live memory.
 */
export async function knewAt(
  client: DriveClient,
  manifestFileId: string,
  timestamp: string,
  keys: BrainKeys,
): Promise<KnewAtView> {
  const revisions = await client.revisionsList(manifestFileId);
  const atOrBefore = revisions.filter((r) => (r.modifiedTime ?? '') <= timestamp);
  const target = atOrBefore[atOrBefore.length - 1];
  if (!target?.id) throw new Error(`knew-at: no manifest revision at or before ${timestamp}`);
  const raw = await client.revisionsGetContent(manifestFileId, target.id);
  const manifest = loadVersionedManifest(JSON.parse(raw), keys.hmacKey);

  const revDay = (target.modifiedTime ?? timestamp).slice(0, 10);
  const tsDay = timestamp.slice(0, 10);
  const delta = readChronicle(revDay, tsDay).filter(
    (o) => o.tTx > (target.modifiedTime ?? '') && o.tTx <= timestamp,
  );

  const knownPaths = new Set(manifest.entries.map((e) => e.logicalPath));
  for (const op of delta) {
    if (op.op === 'deprecate') knownPaths.delete(op.memoryId);
    else knownPaths.add(op.memoryId);
  }
  return { manifest, revisionId: target.id, delta, knownPaths };
}
