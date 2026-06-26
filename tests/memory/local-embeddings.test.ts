/**
 * @file tests/memory/local-embeddings.test.ts
 * @description Covers LocalEmbeddingProvider (B9.1). Fast deterministic cases
 * always run (disabled-mode no-op, isAvailable mirror, empty batch); the
 * real-model assertions (384-dim, L2-normalised, low cosine for unrelated text)
 * are gated behind RUN_LOCAL_EMBED=1 so CI stays fast and offline-safe — they
 * are exercised locally on the box where the model is cached.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalEmbeddingProvider,
  LOCAL_EMBED_DIM,
  __resetLocalEmbedder,
} from '../../src/core/memory/local-embeddings.js';

const SAVED = process.env['SUDO_LOCAL_EMBED'];

afterEach(() => {
  if (SAVED === undefined) delete process.env['SUDO_LOCAL_EMBED'];
  else process.env['SUDO_LOCAL_EMBED'] = SAVED;
  __resetLocalEmbedder();
});

describe('LocalEmbeddingProvider — config & degrade (always run)', () => {
  beforeEach(() => {
    delete process.env['SUDO_LOCAL_EMBED'];
  });

  it('is available by default (master switch default-ON)', () => {
    const p = new LocalEmbeddingProvider();
    expect(p.available).toBe(true);
    expect(p.isAvailable).toBe(true);
    expect(p.dim).toBe(LOCAL_EMBED_DIM);
    expect(LOCAL_EMBED_DIM).toBe(384);
  });

  it('SUDO_LOCAL_EMBED=0 disables it — embed returns null WITHOUT loading a model', async () => {
    process.env['SUDO_LOCAL_EMBED'] = '0';
    const p = new LocalEmbeddingProvider();
    expect(p.available).toBe(false);
    expect(p.isAvailable).toBe(false);
    // No model load happens (would be slow / network); returns null fast.
    await expect(p.embed('hello world')).resolves.toBeNull();
    await expect(p.embedBatch(['a', 'b'])).resolves.toEqual([null, null]);
  });

  it('embedBatch([]) returns [] without loading a model', async () => {
    const p = new LocalEmbeddingProvider();
    await expect(p.embedBatch([])).resolves.toEqual([]);
  });
});

const realModel = process.env['RUN_LOCAL_EMBED'] === '1' ? describe : describe.skip;

realModel('LocalEmbeddingProvider — real ONNX model (RUN_LOCAL_EMBED=1)', () => {
  beforeEach(() => {
    delete process.env['SUDO_LOCAL_EMBED'];
    __resetLocalEmbedder();
  });

  function l2(v: Float32Array): number {
    let s = 0;
    for (const x of v) s += x * x;
    return Math.sqrt(s);
  }
  function dot(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
    return s;
  }

  it('embed() returns a 384-dim L2-normalised vector', async () => {
    const p = new LocalEmbeddingProvider();
    const v = await p.embed('the cat sat on the mat');
    expect(v).not.toBeNull();
    expect(v!.length).toBe(384);
    expect(l2(v!)).toBeCloseTo(1.0, 3);
  }, 120_000);

  it('related text scores higher cosine than unrelated text', async () => {
    const p = new LocalEmbeddingProvider();
    const [base, related, unrelated] = await p.embedBatch([
      'how do I query a vector database for similar embeddings',
      'searching for nearest-neighbour vectors in an embedding index',
      'the weather in Paris is sunny with a chance of rain',
    ]);
    expect(base!.length).toBe(384);
    // cosine == dot product for unit-normalised vectors.
    const simRelated = dot(base!, related!);
    const simUnrelated = dot(base!, unrelated!);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  }, 120_000);
});
