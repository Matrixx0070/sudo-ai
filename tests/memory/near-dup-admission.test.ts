/**
 * @file near-dup-admission.test.ts
 * @description Write-time near-duplicate admission control (near-dup.ts +
 * AutoDream Phase-2 seam). Measured motivation: 41% of learning facts had a
 * ≥0.95-cosine twin (2026-07-31 audit). Admission control gates NEW facts
 * only — never touches existing memory (invariant-9 safe).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MindDB } from '../../src/core/memory/db.js';
import type { EmbeddingService } from '../../src/core/memory/embeddings.js';
import { makeNearDupFinder, recordReDerivation } from '../../src/core/memory/near-dup.js';
import { AutoDream } from '../../src/core/memory/auto-dream.js';

/** Unit 768-d vector with weight on the given axes (unit-normalised). */
function unitVec(axes: Array<[number, number]>): Float32Array {
  const v = new Float32Array(768);
  for (const [i, w] of axes) v[i] = w;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function fakeEmbedder(vec: Float32Array | null, opts: { throwOnEmbed?: boolean } = {}): EmbeddingService {
  return {
    dims: 768,
    isAvailable: true,
    embed: async () => {
      if (opts.throwOnEmbed) throw new Error('embedder down');
      return vec;
    },
  } as unknown as EmbeddingService;
}

let tmpDir: string;
let mind: MindDB;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `near-dup-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mind = new MindDB(path.join(tmpDir, 'mind.db'));
});

afterEach(() => {
  mind.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function storeWithVector(text: string, vec: Float32Array): number {
  const chunk = mind.storeChunk(text, 'memory/auto-dream', 'learning');
  mind.db.prepare('INSERT INTO chunks_vec_768 (chunk_id, embedding) VALUES (:id, :emb)').run({
    id: BigInt(chunk.id),
    emb: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
  });
  return chunk.id;
}

describe('makeNearDupFinder', () => {
  it('reports an active ≥threshold twin', async () => {
    const vec = unitVec([[0, 1]]);
    const id = storeWithVector('the daily budget reset worked correctly', vec);
    const finder = makeNearDupFinder(mind, fakeEmbedder(vec));
    const hit = await finder('daily budget reset was verified working');
    expect(hit).not.toBeNull();
    expect(hit!.chunkId).toBe(id);
    expect(hit!.similarity).toBeGreaterThan(0.99);
  });

  it('admits when the nearest neighbour is below threshold', async () => {
    storeWithVector('completely unrelated fact', unitVec([[0, 1]]));
    // orthogonal query vector → cosine ≈ 0
    const finder = makeNearDupFinder(mind, fakeEmbedder(unitVec([[1, 1]])));
    expect(await finder('something new')).toBeNull();
  });

  it('a superseded twin does not block re-admission (RAG-6 mirror)', async () => {
    const vec = unitVec([[2, 1]]);
    const id = storeWithVector('user prefers concise replies', vec);
    mind.db.prepare("UPDATE chunks SET superseded_by = 999999 WHERE id = :id").run({ id });
    const finder = makeNearDupFinder(mind, fakeEmbedder(vec));
    expect(await finder('user prefers concise replies again')).toBeNull();
  });

  it('fails open when the embedder throws', async () => {
    storeWithVector('anything', unitVec([[3, 1]]));
    const finder = makeNearDupFinder(mind, fakeEmbedder(null, { throwOnEmbed: true }));
    expect(await finder('anything at all')).toBeNull();
  });
});

describe('recordReDerivation', () => {
  it('bumps applied_count without touching text or path (and self-migrates the column)', () => {
    const id = storeWithVector('fact', unitVec([[4, 1]]));
    // Fresh MindDB has no applied_count column (it lives behind the
    // semantic-compactor migration) — first call must self-migrate.
    recordReDerivation(mind, id);
    const before = mind.db.prepare('SELECT applied_count, text FROM chunks WHERE id = :id').get({ id }) as { applied_count: number; text: string };
    recordReDerivation(mind, id);
    const after = mind.db.prepare('SELECT applied_count, text FROM chunks WHERE id = :id').get({ id }) as { applied_count: number; text: string };
    expect(after.applied_count).toBe(before.applied_count + 1);
    expect(after.text).toBe(before.text);
  });
});

describe('AutoDream Phase-2 seam', () => {
  it('suppresses the near-dup fact, stores the fresh one, records re-derivation', async () => {
    const twinVec = unitVec([[5, 1]]);
    const twinId = storeWithVector('cron health warning is historical only', twinVec);

    const recorded: number[] = [];
    const dream = new AutoDream(
      async () => '["cron health WARN is just history", "a brand new lesson"]',
      mind.db,
      undefined,
      undefined,
      {
        find: async (text: string) =>
          text.startsWith('cron') ? { chunkId: twinId, similarity: 0.97 } : null,
        recordReDerivation: (chunkId: number) => { recorded.push(chunkId); },
      },
    );
    // Drive the Phase-2 loop directly with one fake message.
    const stored = await (dream as unknown as {
      _synthesize(m: Array<{ role: string; content: string }>): Promise<number>;
    })._synthesize([{ role: 'user', content: 'transcript line' }]);

    expect(stored).toBe(1);
    expect(recorded).toEqual([twinId]);
    const rows = mind.db.prepare("SELECT text FROM chunks WHERE source = 'learning' AND path = 'memory/auto-dream'").all() as Array<{ text: string }>;
    expect(rows.some((r) => r.text === 'a brand new lesson')).toBe(true);
    expect(rows.some((r) => r.text === 'cron health WARN is just history')).toBe(false);
  });
});
