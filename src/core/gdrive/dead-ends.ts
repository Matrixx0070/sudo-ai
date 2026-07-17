/**
 * @file gdrive/dead-ends.ts
 * @description F33 — negative knowledge: a doom loop detected once is never
 * re-entered.
 *
 * Records live in a local index (data/gdrive/dead-ends.json), mirror to Drive
 * memory/dead-ends/, and surface to planning as structured 'feedback'
 * memories prefixed "DEAD END" (the intelligence brief's structured search
 * already prioritizes feedback — the retrieval rule "a matching dead end
 * outranks fresh similarity" is approximated by that channel; logged as a
 * deviation in the status doc).
 *
 * Producers: the DoomLoopDetector's doom_loop_terminated hook events (cli.ts
 * subscribes and drafts candidates here), dream-cycle confirmation (F12),
 * and F6 comments. Consumer: planner pre-check via matchDeadEnds().
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { StructuredStoreLike } from './brain-serializer.js';

const log = createLogger('gdrive:dead-ends');

export interface DeadEnd {
  id: string;
  summary: string;
  /** Normalized keys used for matching (tool names, error signatures, args digests). */
  patternKeys: string[];
  context: string;
  cause: string;
  /** F10 bundle reference where one exists. */
  evidenceRef?: string;
  createdAt: string;
  status: 'candidate' | 'confirmed';
}

interface DeadEndsIndex {
  deadEnds: DeadEnd[];
}

export function deadEndsPath(): string {
  return dataPath('gdrive', 'dead-ends.json');
}

function load(): DeadEndsIndex {
  try {
    const parsed = JSON.parse(readFileSync(deadEndsPath(), 'utf-8')) as DeadEndsIndex;
    return { deadEnds: parsed.deadEnds ?? [] };
  } catch {
    return { deadEnds: [] };
  }
}

function save(index: DeadEndsIndex): void {
  const p = deadEndsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

export function normalizePatternKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

function idFor(patternKeys: string[]): string {
  return `de-${createHash('sha256').update(patternKeys.slice().sort().join('|')).digest('hex').slice(0, 16)}`;
}

/** Draft a candidate (doom-loop abort events land here). Dedups by pattern. */
export function draftDeadEnd(params: {
  summary: string;
  patternKeys: string[];
  context: string;
  cause: string;
  evidenceRef?: string;
}): DeadEnd {
  const index = load();
  const patternKeys = params.patternKeys.map(normalizePatternKey).filter(Boolean);
  const id = idFor(patternKeys);
  const existing = index.deadEnds.find((d) => d.id === id);
  if (existing) return existing;
  const deadEnd: DeadEnd = {
    id,
    summary: params.summary.slice(0, 500),
    patternKeys,
    context: params.context.slice(0, 1000),
    cause: params.cause.slice(0, 500),
    evidenceRef: params.evidenceRef,
    createdAt: new Date().toISOString(),
    status: 'candidate',
  };
  index.deadEnds.push(deadEnd);
  save(index);
  log.info({ id, patternKeys: patternKeys.length }, 'dead-end candidate drafted');
  return deadEnd;
}

/** Confirm a candidate (dream cycle / F6 comment) and surface it to planning. */
export async function confirmDeadEnd(
  id: string,
  structured: StructuredStoreLike,
): Promise<DeadEnd | null> {
  const index = load();
  const deadEnd = index.deadEnds.find((d) => d.id === id);
  if (!deadEnd) return null;
  deadEnd.status = 'confirmed';
  save(index);
  await structured.saveMemory({
    type: 'feedback',
    id: `deadend-${deadEnd.id}`,
    name: `DEAD END: ${deadEnd.summary.slice(0, 80)}`,
    description: 'CONFIRMED dead end — plans matching this pattern must explain why this time differs, or abort',
    content: [
      `[DEAD END — do not re-enter]`,
      `Summary: ${deadEnd.summary}`,
      `Cause: ${deadEnd.cause}`,
      `Patterns: ${deadEnd.patternKeys.join(' | ')}`,
      deadEnd.evidenceRef ? `Evidence: ${deadEnd.evidenceRef}` : '',
    ].filter(Boolean).join('\n'),
  });
  return deadEnd;
}

export function listDeadEnds(status?: DeadEnd['status']): DeadEnd[] {
  const all = load().deadEnds;
  return status ? all.filter((d) => d.status === status) : all;
}

/**
 * Planner pre-check: does the plan text hit any confirmed dead end? A match
 * requires the plan to explicitly address why this time differs, or abort.
 */
export function matchDeadEnds(planText: string, minKeyHits = 1): DeadEnd[] {
  const normalized = normalizePatternKey(planText);
  return load()
    .deadEnds.filter((d) => d.status === 'confirmed')
    .filter((d) => d.patternKeys.filter((k) => normalized.includes(k)).length >= minKeyHits);
}

/** Mirror confirmed records to Drive memory/dead-ends/ (idempotent by name). */
export async function uploadDeadEnds(client: DriveClient, folders: FolderIdMap): Promise<number> {
  const folderId = folders['memory/dead-ends'];
  if (!folderId) return 0;
  const remote = new Set((await client.listChildren(folderId)).map((f) => f.name));
  let uploaded = 0;
  for (const d of listDeadEnds('confirmed')) {
    const name = `${d.id}.json`;
    if (remote.has(name)) continue;
    await client.filesCreate(
      { name, parents: [folderId] },
      { mimeType: 'application/json', body: JSON.stringify(d, null, 2) },
    );
    uploaded++;
  }
  return uploaded;
}

/** Test/ops probe. */
export function hasDeadEndsIndex(): boolean {
  return existsSync(deadEndsPath());
}
