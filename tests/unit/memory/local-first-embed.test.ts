/**
 * Guards makeLocalFirstEmbed — prefer the always-up local ONNX embedder, fall
 * back to OpenAI only when local is unavailable. This is what lets
 * chunk-contradiction stop failing on OpenAI 429s while keeping a call's vectors
 * dimension-consistent (local stays available for the whole call).
 */
import { describe, it, expect, vi } from 'vitest';
import { makeLocalFirstEmbed } from '../../../src/core/memory/local-embeddings.js';

describe('makeLocalFirstEmbed', () => {
  it('uses the local vector when the local model is available (no fallback call)', async () => {
    const localVec = new Float32Array([0.1, 0.2, 0.3]);
    const fallback = vi.fn(async () => new Float32Array([9]));
    const embed = makeLocalFirstEmbed(fallback, { embed: async () => localVec });
    expect(await embed('hello')).toBe(localVec);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the provided fn when local returns null', async () => {
    const fbVec = new Float32Array([9]);
    const fallback = vi.fn(async () => fbVec);
    const embed = makeLocalFirstEmbed(fallback, { embed: async () => null });
    expect(await embed('hello')).toBe(fbVec);
    expect(fallback).toHaveBeenCalledWith('hello');
  });

  it('returns null when both local and fallback are unavailable', async () => {
    const embed = makeLocalFirstEmbed(async () => null, { embed: async () => null });
    expect(await embed('hello')).toBeNull();
  });
});
