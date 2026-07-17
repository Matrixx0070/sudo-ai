/**
 * @file gdrive/datasets.ts
 * @description F26 — dataset farming: training/exemplar data as a free side
 * effect of operating. Local JSONL under data/gdrive/datasets/, closed rows
 * mirrored to datasets/ in Drive daily. Near-term consumer: the exemplar
 * bank — best-of few-shot retrieval at prompt-construction time, with
 * zone-1-sensitive rows PROVABLY excluded from general-context exemplars.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { classifyZone } from './zones.js';

const log = createLogger('gdrive:datasets');

export type DatasetName = 'corrections' | 'eval-pairs' | 'edits';

export function datasetsDir(): string {
  return dataPath('gdrive', 'datasets');
}

function fileFor(name: DatasetName): string {
  return join(datasetsDir(), `${name}.jsonl`);
}

/** Append one structured row. Rows are data; never executed. */
export function appendDatasetRow(name: DatasetName, row: Record<string, unknown>): void {
  mkdirSync(datasetsDir(), { recursive: true });
  appendFileSync(fileFor(name), JSON.stringify({ ...row, _at: row['_at'] ?? new Date().toISOString() }) + '\n', {
    mode: 0o600,
  });
}

export function readDataset<T = Record<string, unknown>>(name: DatasetName): T[] {
  const p = fileFor(name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((r): r is T => r !== null);
}

// ---------------------------------------------------------------------------
// Exemplar bank
// ---------------------------------------------------------------------------

export interface Exemplar {
  dataset: DatasetName;
  text: string;
  score: number;
}

function rowText(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([k]) => !k.startsWith('_'))
    .map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' ');
}

/**
 * Keyword-scored few-shot retrieval. Zone-1-classified rows are excluded
 * from general-context exemplars (F29 invariant — test-asserted).
 */
export function retrieveExemplars(query: string, k = 3, datasets: DatasetName[] = ['corrections', 'eval-pairs', 'edits']): Exemplar[] {
  const terms = (query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(Boolean);
  if (!terms.length) return [];
  const out: Exemplar[] = [];
  for (const name of datasets) {
    for (const row of readDataset(name)) {
      const text = rowText(row);
      if (classifyZone(text) !== 2) continue; // sensitive rows never surface
      const hits = terms.filter((t) => text.toLowerCase().includes(t)).length;
      if (hits > 0) out.push({ dataset: name, text: text.slice(0, 1200), score: hits / terms.length });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Mirror datasets to Drive (same file updated in place; revisions = history). */
export async function uploadDatasets(client: DriveClient, folders: FolderIdMap): Promise<number> {
  const folderId = folders['datasets'];
  if (!folderId || !existsSync(datasetsDir())) return 0;
  const remote = new Map((await client.listChildren(folderId)).map((f) => [f.name, f.id]));
  let uploaded = 0;
  for (const f of readdirSync(datasetsDir()).filter((x) => x.endsWith('.jsonl'))) {
    const body = readFileSync(join(datasetsDir(), f), 'utf-8');
    const existing = remote.get(f);
    if (existing) await client.filesUpdate(existing, {}, { mimeType: 'application/jsonl', body });
    else await client.filesCreate({ name: f, parents: [folderId] }, { mimeType: 'application/jsonl', body });
    uploaded++;
  }
  if (uploaded) log.debug({ uploaded }, 'datasets mirrored');
  return uploaded;
}
