/**
 * @file gdrive/deep-freeze.ts
 * @description F11 (tier-4 deep-freeze) + F27 (free recall over it).
 *
 * Rule enforced in code: INDEX HOT, PAYLOAD COLD. Episodic records (daily
 * workspace/memory/*.md logs and other eligible files) older than N days
 * evict from local disk; a manifest stub (id, one-line summary, keywords)
 * stays hot in data/gdrive/freeze-index.json. Payloads live as
 * content-addressed Drive blobs. Recall = stub hit -> BACKGROUND prefetch
 * into an LRU-capped local cache — never a synchronous Drive wait on the
 * loop (recallFrozen returns immediately with cache state; prefetch is
 * fire-and-forget).
 *
 * F27: Drive fullText search over the blobs folder as a coarse fallback that
 * returns candidates to prefetch (zone-2 only — zone-1 is intentionally
 * unsearchable, the documented F29 tradeoff).
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { Readable } from 'node:stream';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { sha256Hex } from './manifest.js';

const log = createLogger('gdrive:deep-freeze');

export interface FreezeStub {
  id: string; // sha256 of payload
  originalPath: string;
  summary: string; // first non-empty line
  keywords: string[];
  bytes: number;
  frozenAt: string;
  driveFileId: string;
}

interface FreezeIndex {
  stubs: FreezeStub[];
}

export function freezeIndexPath(): string {
  return dataPath('gdrive', 'freeze-index.json');
}

export function freezeCacheDir(): string {
  return dataPath('gdrive', 'freeze-cache');
}

const DEFAULT_CACHE_CAP = 50;

function loadIndex(): FreezeIndex {
  try {
    return { stubs: (JSON.parse(readFileSync(freezeIndexPath(), 'utf-8')) as FreezeIndex).stubs ?? [] };
  } catch {
    return { stubs: [] };
  }
}

function saveIndex(index: FreezeIndex): void {
  const p = freezeIndexPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function extractKeywords(text: string, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/**
 * Freeze one local file: upload payload as a content-addressed blob, write
 * the hot stub, DELETE the local payload. Refuses zone-risky content? No —
 * eligibility is the CALLER's policy; this is the mechanism.
 */
export async function freezeFile(
  client: DriveClient,
  folders: FolderIdMap,
  filePath: string,
): Promise<FreezeStub> {
  const blobsFolder = folders['memory/blobs'];
  if (!blobsFolder) throw new Error('deep-freeze: memory/blobs folder id missing');
  const content = readFileSync(filePath);
  const id = sha256Hex(content);
  const index = loadIndex();
  const existing = index.stubs.find((s) => s.id === id);
  if (existing) {
    rmSync(filePath, { force: true });
    return existing;
  }
  // Content-addressed: skip upload when the blob already exists remotely.
  const remoteName = id;
  const remote = (await client.listChildren(blobsFolder)).find((f) => f.name === remoteName);
  const driveFileId =
    remote?.id ??
    (
      await client.filesCreate(
        { name: remoteName, parents: [blobsFolder] },
        { mimeType: 'text/plain', body: Readable.from(content) },
      )
    ).id;

  const text = content.toString('utf-8');
  const stub: FreezeStub = {
    id,
    originalPath: filePath,
    summary: (text.split('\n').find((l) => l.trim()) ?? '').slice(0, 160),
    keywords: extractKeywords(text),
    bytes: content.length,
    frozenAt: new Date().toISOString(),
    driveFileId,
  };
  index.stubs.push(stub);
  saveIndex(index);
  rmSync(filePath, { force: true });
  log.info({ file: basename(filePath), bytes: stub.bytes }, 'file frozen to deep storage');
  return stub;
}

/** Evict eligible episodic day-logs older than maxAgeDays. */
export async function runFreezeSweep(
  client: DriveClient,
  folders: FolderIdMap,
  episodicDir: string,
  maxAgeDays = 30,
  now: Date = new Date(),
): Promise<FreezeStub[]> {
  if (!existsSync(episodicDir)) return [];
  const frozen: FreezeStub[] = [];
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  for (const f of readdirSync(episodicDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue; // day logs only
    const p = join(episodicDir, f);
    if (statSync(p).mtimeMs < cutoff) {
      frozen.push(await freezeFile(client, folders, p));
    }
  }
  return frozen;
}

// ---------------------------------------------------------------------------
// Recall (stub search + background prefetch; LRU cache)
// ---------------------------------------------------------------------------

/** Hot-index keyword search over stubs (no Drive I/O). */
export function searchStubs(query: string, limit = 5): FreezeStub[] {
  const terms = (query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(Boolean);
  if (!terms.length) return [];
  return loadIndex()
    .stubs.map((s) => ({
      s,
      hits: terms.filter((t) => s.keywords.some((k) => k.includes(t)) || s.summary.toLowerCase().includes(t)).length,
    }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.s);
}

function cachePathFor(id: string): string {
  return join(freezeCacheDir(), id);
}

/** Non-blocking recall: cached payload or null + fire-and-forget prefetch. */
export function recallFrozen(
  client: DriveClient,
  stub: FreezeStub,
  opts: { cacheCap?: number } = {},
): { cached: string | null; prefetching: boolean } {
  const p = cachePathFor(stub.id);
  if (existsSync(p)) {
    return { cached: readFileSync(p, 'utf-8'), prefetching: false };
  }
  // Background prefetch — the CURRENT turn never waits (prime directive 1).
  void prefetchFrozen(client, stub, opts).catch((err) =>
    log.warn({ err: String(err), id: stub.id }, 'freeze prefetch failed'),
  );
  return { cached: null, prefetching: true };
}

/** Awaitable prefetch (the background half of recallFrozen; tests await it). */
export async function prefetchFrozen(
  client: DriveClient,
  stub: FreezeStub,
  opts: { cacheCap?: number } = {},
): Promise<string> {
  const text = await client.filesDownload(stub.driveFileId, { lane: 'background' });
  mkdirSync(freezeCacheDir(), { recursive: true });
  writeFileSync(cachePathFor(stub.id), text, { mode: 0o600 });
  enforceLru(opts.cacheCap ?? DEFAULT_CACHE_CAP);
  return text;
}

function enforceLru(cap: number): void {
  const dir = freezeCacheDir();
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .map((f) => ({ f, at: statSync(join(dir, f)).atimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const victim of files.slice(cap)) {
    rmSync(join(dir, victim.f), { force: true });
  }
}

// ---------------------------------------------------------------------------
// F27 — Drive full-text fallback
// ---------------------------------------------------------------------------

/**
 * Coarse keyword recall over cold zone-2 blobs via Drive fullText search.
 * Returns matching stubs (by driveFileId) as prefetch candidates.
 */
export async function freeRecall(
  client: DriveClient,
  folders: FolderIdMap,
  keyword: string,
  limit = 5,
): Promise<FreezeStub[]> {
  const blobsFolder = folders['memory/blobs'];
  if (!blobsFolder) return [];
  const safe = keyword.replace(/['"\\]/g, ' ').trim();
  if (!safe) return [];
  const page = await client.filesList({
    q: `fullText contains '${safe}' and '${blobsFolder}' in parents and trashed = false`,
    pageSize: limit,
  });
  const byDriveId = new Map(loadIndex().stubs.map((s) => [s.driveFileId, s]));
  return page.files.map((f) => byDriveId.get(f.id)).filter((s): s is FreezeStub => !!s);
}

/** Test/ops probe. */
export function hasFreezeIndex(): boolean {
  return existsSync(freezeIndexPath());
}
