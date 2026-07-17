/**
 * @file gdrive/brain-serializer.ts
 * @description F2 — serialize/apply "consolidated memory" across the three
 * backends recon identified (status doc D7):
 *
 *   1. mind.db chunks (the consolidated tier)   -> chunks/zone{1,2}.jsonl
 *   2. data/structured-memory JSON records      -> structured/zone{1,2}.jsonl
 *   3. workspace/MEMORY.md                      -> workspace/MEMORY.md
 *
 * Zone handling: every record is classified individually (classifyZone);
 * bundles are split per zone so a zone-1 record never rides in a plaintext
 * blob. Zone-0 records are included in the input list with zone 0 and get
 * filtered by the push layer (belt) after being segregated here (suspenders).
 *
 * Apply (restore) goes EXCLUSIVELY through the internal memory API —
 * storeChunk (which runs guardMemoryWrite) and saveMemory — never raw SQL
 * (prime directive 2).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKSPACE_DIR } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import { classifyZone, type Zone } from './zones.js';
import type { BrainBlobInput } from './blob-store.js';

const log = createLogger('gdrive:brain-serializer');

// ---------------------------------------------------------------------------
// Duck-typed memory API surfaces (test-injectable; real impls: MindDB and
// structured-memory.ts)
// ---------------------------------------------------------------------------

export interface ChunkLike {
  text: string;
  path: string;
  source: 'conversation' | 'file' | 'tool' | 'learning';
  hash: string;
  isEvergreen: boolean;
  createdAt: string;
}

export interface ChunkStoreLike {
  getActiveChunks(limit?: number): ChunkLike[];
  storeChunk(
    text: string,
    path: string,
    source: 'conversation' | 'file' | 'tool' | 'learning',
    opts?: { isEvergreen?: boolean; role?: string },
  ): unknown;
}

export interface StructuredMemoryLike {
  type: string;
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface StructuredStoreLike {
  listMemories(): Promise<StructuredMemoryLike[]>;
  saveMemory(memory: StructuredMemoryLike): Promise<unknown>;
}

export interface BrainSnapshotDeps {
  chunks: ChunkStoreLike;
  structured: StructuredStoreLike;
  /** Path to MEMORY.md; defaults to workspace/MEMORY.md. */
  memoryMdPath?: string;
  /** Max chunks per snapshot (safety bound). */
  chunkLimit?: number;
}

const DEFAULT_CHUNK_LIMIT = 100_000;

export function defaultMemoryMdPath(): string {
  return join(WORKSPACE_DIR, 'MEMORY.md');
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

function toJsonl(records: unknown[]): Buffer {
  return Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function splitZones<T>(records: T[], textOf: (r: T) => string): Record<1 | 2, T[]> {
  const out: Record<1 | 2, T[]> = { 1: [], 2: [] };
  for (const r of records) {
    const zone = classifyZone(textOf(r));
    if (zone === 0) continue; // never-sync marker — stays local, full stop
    out[zone].push(r);
  }
  return out;
}

/** Snapshot the three backends into push-ready blob inputs. */
export async function collectBrainSnapshot(deps: BrainSnapshotDeps): Promise<BrainBlobInput[]> {
  const inputs: BrainBlobInput[] = [];

  // 1. mind.db chunks
  const chunks = deps.chunks.getActiveChunks(deps.chunkLimit ?? DEFAULT_CHUNK_LIMIT).map((c) => ({
    text: c.text,
    path: c.path,
    source: c.source,
    hash: c.hash,
    isEvergreen: c.isEvergreen,
    createdAt: c.createdAt,
  }));
  const chunksByZone = splitZones(chunks, (c) => c.text);
  for (const zone of [1, 2] as const) {
    if (chunksByZone[zone].length > 0) {
      inputs.push({
        logicalPath: `chunks/zone${zone}.jsonl`,
        content: toJsonl(chunksByZone[zone]),
        zone,
        category: 'knowledge',
      });
    }
  }

  // 2. structured memories
  const structured = await deps.structured.listMemories();
  const structuredByZone = splitZones(structured, (m) => `${m.name}\n${m.description}\n${m.content}`);
  for (const zone of [1, 2] as const) {
    if (structuredByZone[zone].length > 0) {
      inputs.push({
        logicalPath: `structured/zone${zone}.jsonl`,
        content: toJsonl(structuredByZone[zone]),
        zone,
        category: 'knowledge',
      });
    }
  }

  // 2.5 Epistemic sidecar files (Phase 5): beliefs graph, prospective notes,
  // dead-ends index — zone-2 JSON state that must survive kill-and-restore.
  const { dataPath } = await import('../shared/paths.js');
  const { join } = await import('node:path');
  const sidecars: Array<{ file: string; logicalPath: string }> = [
    { file: join(dataPath('gdrive'), 'beliefs-graph.json'), logicalPath: 'epistemics/beliefs-graph.json' },
    { file: join(dataPath('gdrive'), 'prospective.json'), logicalPath: 'epistemics/prospective.json' },
    { file: join(dataPath('gdrive'), 'dead-ends.json'), logicalPath: 'epistemics/dead-ends.json' },
  ];
  for (const s of sidecars) {
    if (existsSync(s.file)) {
      inputs.push({
        logicalPath: s.logicalPath,
        content: readFileSync(s.file),
        zone: 2,
        category: 'knowledge',
      });
    }
  }

  // 3. workspace/MEMORY.md — the human-readable long-term policy surface.
  const mdPath = deps.memoryMdPath ?? defaultMemoryMdPath();
  if (existsSync(mdPath)) {
    const text = readFileSync(mdPath, 'utf-8');
    if (text.trim().length > 0) {
      const zone = classifyZone(text);
      if (zone !== 0) {
        inputs.push({
          logicalPath: 'workspace/MEMORY.md',
          content: Buffer.from(text, 'utf-8'),
          zone,
          category: 'policy',
        });
      }
    }
  }

  return inputs;
}

// ---------------------------------------------------------------------------
// Apply (restore)
// ---------------------------------------------------------------------------

export interface ApplyReport {
  chunksApplied: number;
  structuredApplied: number;
  memoryMdWritten: boolean;
}

function parseJsonl<T>(buf: Buffer): T[] {
  return buf
    .toString('utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/**
 * Apply a hydrated snapshot through the memory API. Chunk dedup is free
 * (storeChunk is hash-deduped), so re-applying is idempotent.
 */
export async function applyBrainSnapshot(
  blobs: Map<string, Buffer>,
  deps: BrainSnapshotDeps,
): Promise<ApplyReport> {
  const report: ApplyReport = { chunksApplied: 0, structuredApplied: 0, memoryMdWritten: false };

  for (const logicalPath of ['chunks/zone1.jsonl', 'chunks/zone2.jsonl']) {
    const blob = blobs.get(logicalPath);
    if (!blob) continue;
    for (const c of parseJsonl<ChunkLike>(blob)) {
      // Through the API: guardMemoryWrite runs inside storeChunk. Restored
      // content is our own signed data — role 'assistant' scopes the scan
      // correctly (untrusted-only patterns skipped).
      deps.chunks.storeChunk(c.text, c.path, c.source, {
        isEvergreen: c.isEvergreen,
        role: 'assistant',
      });
      report.chunksApplied++;
    }
  }

  const structuredBlobs = ['structured/zone1.jsonl', 'structured/zone2.jsonl'];
  for (const logicalPath of structuredBlobs) {
    const blob = blobs.get(logicalPath);
    if (!blob) continue;
    for (const m of parseJsonl<StructuredMemoryLike>(blob)) {
      await deps.structured.saveMemory(m);
      report.structuredApplied++;
    }
  }

  // Epistemic sidecars: restore only when absent locally (local state wins —
  // it is newer by definition on the machine that kept running).
  {
    const { dataPath } = await import('../shared/paths.js');
    const { join } = await import('node:path');
    const sidecars: Array<{ file: string; logicalPath: string }> = [
      { file: join(dataPath('gdrive'), 'beliefs-graph.json'), logicalPath: 'epistemics/beliefs-graph.json' },
      { file: join(dataPath('gdrive'), 'prospective.json'), logicalPath: 'epistemics/prospective.json' },
      { file: join(dataPath('gdrive'), 'dead-ends.json'), logicalPath: 'epistemics/dead-ends.json' },
    ];
    for (const s of sidecars) {
      const blob = blobs.get(s.logicalPath);
      if (blob && !existsSync(s.file)) {
        mkdirSync(dirname(s.file), { recursive: true });
        writeFileSync(s.file, blob, { mode: 0o600 });
      }
    }
  }

  const md = blobs.get('workspace/MEMORY.md');
  if (md) {
    const mdPath = deps.memoryMdPath ?? defaultMemoryMdPath();
    const incoming = md.toString('utf-8');
    const current = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : '';
    if (incoming !== current) {
      mkdirSync(dirname(mdPath), { recursive: true });
      if (current) {
        // Never destroy the local file silently — timestamped backup first.
        const backup = `${mdPath}.pre-hydrate.${Date.now()}.bak`;
        writeFileSync(backup, current);
        log.info({ backup }, 'MEMORY.md backed up before hydrate overwrite');
      }
      writeFileSync(mdPath, incoming);
      report.memoryMdWritten = true;
    }
  }

  return report;
}
